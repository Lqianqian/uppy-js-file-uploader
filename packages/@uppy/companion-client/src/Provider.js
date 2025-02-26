'use strict'

import RequestClient from './RequestClient.js'
import * as tokenStorage from './tokenStorage.js'

const getName = (id) => {
  return id.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
}

function getOrigin () {
  // eslint-disable-next-line no-restricted-globals
  return location.origin
}

function getRegex (value) {
  if (typeof value === 'string') {
    return new RegExp(`^${value}$`)
  } if (value instanceof RegExp) {
    return value
  }
  return undefined
}

function isOriginAllowed (origin, allowedOrigin) {
  const patterns = Array.isArray(allowedOrigin) ? allowedOrigin.map(getRegex) : [getRegex(allowedOrigin)]
  return patterns
    .some((pattern) => pattern?.test(origin) || pattern?.test(`${origin}/`)) // allowing for trailing '/'
}

export default class Provider extends RequestClient {
  #refreshingTokenPromise

  constructor (uppy, opts) {
    super(uppy, opts)
    this.provider = opts.provider
    this.id = this.provider
    this.name = this.opts.name || getName(this.id)
    this.pluginId = this.opts.pluginId
    this.tokenKey = `companion-${this.pluginId}-auth-token`
    this.companionKeysParams = this.opts.companionKeysParams
    this.preAuthToken = null
  }

  async headers () {
    const [headers, token] = await Promise.all([super.headers(), this.#getAuthToken()])
    const authHeaders = {}
    if (token) {
      authHeaders['uppy-auth-token'] = token
    }

    if (this.companionKeysParams) {
      authHeaders['uppy-credentials-params'] = btoa(
        JSON.stringify({ params: this.companionKeysParams }),
      )
    }
    return { ...headers, ...authHeaders }
  }

  onReceiveResponse (response) {
    super.onReceiveResponse(response)
    const plugin = this.uppy.getPlugin(this.pluginId)
    const oldAuthenticated = plugin.getPluginState().authenticated
    const authenticated = oldAuthenticated ? response.status !== 401 : response.status < 400
    plugin.setPluginState({ authenticated })
    return response
  }

  async setAuthToken (token) {
    return this.uppy.getPlugin(this.pluginId).storage.setItem(this.tokenKey, token)
  }

  async #getAuthToken () {
    return this.uppy.getPlugin(this.pluginId).storage.getItem(this.tokenKey)
  }

  async #removeAuthToken () {
    return this.uppy.getPlugin(this.pluginId).storage.removeItem(this.tokenKey)
  }

  /**
   * Ensure we have a preauth token if necessary. Attempts to fetch one if we don't,
   * or rejects if loading one fails.
   */
  async ensurePreAuth () {
    if (this.companionKeysParams && !this.preAuthToken) {
      await this.fetchPreAuthToken()

      if (!this.preAuthToken) {
        throw new Error('Could not load authentication data required for third-party login. Please try again later.')
      }
    }
  }

  authUrl (queries = {}) {
    const params = new URLSearchParams({
      state: btoa(JSON.stringify({ origin: getOrigin() })),
      ...queries,
    })
    if (this.preAuthToken) {
      params.set('uppyPreAuthToken', this.preAuthToken)
    }

    return `${this.hostname}/${this.id}/connect?${params}`
  }

  async login (queries) {
    await this.ensurePreAuth()

    return new Promise((resolve, reject) => {
      const link = this.authUrl(queries)
      const authWindow = window.open(link, '_blank')
      const handleToken = (e) => {
        if (e.source !== authWindow) {
          this.uppy.log.warn('ignoring event from unknown source', e)
          return
        }

        const { companionAllowedHosts } = this.uppy.getPlugin(this.pluginId).opts
        if (!isOriginAllowed(e.origin, companionAllowedHosts)) {
          reject(new Error(`rejecting event from ${e.origin} vs allowed pattern ${companionAllowedHosts}`))
          return
        }

        // Check if it's a string before doing the JSON.parse to maintain support
        // for older Companion versions that used object references
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data

        if (data.error) {
          const { uppy } = this
          const message = uppy.i18n('authAborted')
          uppy.info({ message }, 'warning', 5000)
          reject(new Error('auth aborted'))
          return
        }

        if (!data.token) {
          reject(new Error('did not receive token from auth window'))
          return
        }

        authWindow.close()
        window.removeEventListener('message', handleToken)
        this.setAuthToken(data.token).then(() => resolve()).catch(reject)
      }
      window.addEventListener('message', handleToken)
    })
  }

  refreshTokenUrl () {
    return `${this.hostname}/${this.id}/refresh-token`
  }

  fileUrl (id) {
    return `${this.hostname}/${this.id}/get/${id}`
  }

  /** @protected */
  async request (...args) {
    await this.#refreshingTokenPromise

    try {
      // to test simulate access token expired (leading to a token token refresh),
      // see mockAccessTokenExpiredError in companion/drive.
      // If you want to test refresh token *and* access token invalid, do this for example with Google Drive:
      // While uploading, go to your google account settings,
      // "Third-party apps & services", then click "Companion" and "Remove access".

      return await super.request(...args)
    } catch (err) {
      // only handle auth errors (401 from provider), and only handle them if we have a (refresh) token
      const authTokenAfter = await this.#getAuthToken()
      if (!err.isAuthError || !authTokenAfter) throw err

      if (this.#refreshingTokenPromise == null) {
        // Many provider requests may be starting at once, however refresh token should only be called once.
        // Once a refresh token operation has started, we need all other request to wait for this operation (atomically)
        this.#refreshingTokenPromise = (async () => {
          try {
            this.uppy.log(`[CompanionClient] Refreshing expired auth token`, 'info')
            const response = await super.request({ path: this.refreshTokenUrl(), method: 'POST' })
            await this.setAuthToken(response.uppyAuthToken)
          } catch (refreshTokenErr) {
            if (refreshTokenErr.isAuthError) {
              // if refresh-token has failed with auth error, delete token, so we don't keep trying to refresh in future
              await this.#removeAuthToken()
            }
            throw err
          } finally {
            this.#refreshingTokenPromise = undefined
          }
        })()
      }

      await this.#refreshingTokenPromise

      // now retry the request with our new refresh token
      return super.request(...args)
    }
  }

  async fetchPreAuthToken () {
    if (!this.companionKeysParams) {
      return
    }

    try {
      const res = await this.post(`${this.id}/preauth/`, { params: this.companionKeysParams })
      this.preAuthToken = res.token
    } catch (err) {
      this.uppy.log(`[CompanionClient] unable to fetch preAuthToken ${err}`, 'warning')
    }
  }

  list (directory, options) {
    return this.get(`${this.id}/list/${directory || ''}`, options)
  }

  async logout (options) {
    const response = await this.get(`${this.id}/logout`, options)
    await this.#removeAuthToken()
    return response
  }

  static initPlugin (plugin, opts, defaultOpts) {
    /* eslint-disable no-param-reassign */
    plugin.type = 'acquirer'
    plugin.files = []
    if (defaultOpts) {
      plugin.opts = { ...defaultOpts, ...opts }
    }

    if (opts.serverUrl || opts.serverPattern) {
      throw new Error('`serverUrl` and `serverPattern` have been renamed to `companionUrl` and `companionAllowedHosts` respectively in the 0.30.5 release. Please consult the docs (for example, https://uppy.io/docs/instagram/ for the Instagram plugin) and use the updated options.`')
    }

    if (opts.companionAllowedHosts) {
      const pattern = opts.companionAllowedHosts
      // validate companionAllowedHosts param
      if (typeof pattern !== 'string' && !Array.isArray(pattern) && !(pattern instanceof RegExp)) {
        throw new TypeError(`${plugin.id}: the option "companionAllowedHosts" must be one of string, Array, RegExp`)
      }
      plugin.opts.companionAllowedHosts = pattern
    } else if (/^(?!https?:\/\/).*$/i.test(opts.companionUrl)) {
      // does not start with https://
      plugin.opts.companionAllowedHosts = `https://${opts.companionUrl.replace(/^\/\//, '')}`
    } else {
      plugin.opts.companionAllowedHosts = new URL(opts.companionUrl).origin
    }

    plugin.storage = plugin.opts.storage || tokenStorage
    /* eslint-enable no-param-reassign */
  }
}
