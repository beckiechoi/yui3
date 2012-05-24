/**
Provides URL-based routing using HTML5 `pushState()` or the location hash.

@module app
@submodule router
@since 3.4.0
**/

var HistoryHash = Y.HistoryHash,
    QS          = Y.QueryString,
    YArray      = Y.Array,

    win = Y.config.win,

    // We have to queue up pushState calls to avoid race conditions, since the
    // popstate event doesn't actually provide any info on what URL it's
    // associated with.
    saveQueue = [],

    /**
    Fired when the router is ready to begin dispatching to route handlers.

    You shouldn't need to wait for this event unless you plan to implement some
    kind of custom dispatching logic. It's used internally in order to avoid
    dispatching to an initial route if a browser history change occurs first.

    @event ready
    @param {Boolean} dispatched `true` if routes have already been dispatched
      (most likely due to a history change).
    @fireOnce
    **/
    EVT_READY = 'ready';

/**
Provides URL-based routing using HTML5 `pushState()` or the location hash.

This makes it easy to wire up route handlers for different application states
while providing full back/forward navigation support and bookmarkable, shareable
URLs.

@class Router
@param {Object} [config] Config properties.
    @param {Boolean} [config.html5] Overrides the default capability detection
        and forces this router to use (`true`) or not use (`false`) HTML5
        history.
    @param {String} [config.root=''] Root path from which all routes should be
        evaluated.
    @param {Array} [config.routes=[]] Array of route definition objects.
@constructor
@extends Base
@since 3.4.0
**/
function Router() {
    Router.superclass.constructor.apply(this, arguments);
}

Y.Router = Y.extend(Router, Y.Base, {
    // -- Protected Properties -------------------------------------------------

    /**
    Whether or not `_dispatch()` has been called since this router was
    instantiated.

    @property _dispatched
    @type Boolean
    @default undefined
    @protected
    **/

    /**
    Whether or not we're currently in the process of dispatching to routes.

    @property _dispatching
    @type Boolean
    @default undefined
    @protected
    **/

    /**
    History event handle for the `history:change` or `hashchange` event
    subscription.

    @property _historyEvents
    @type EventHandle
    @protected
    **/

    /**
    Cached copy of the `html5` attribute for internal use.

    @property _html5
    @type Boolean
    @protected
    **/

    /**
    Whether or not the `ready` event has fired yet.

    @property _ready
    @type Boolean
    @default undefined
    @protected
    **/

    /**
    Regex used to match parameter placeholders in route paths.

    Subpattern captures:

      1. Parameter prefix character. Either a `:` for subpath parameters that
         should only match a single level of a path, or `*` for splat parameters
         that should match any number of path levels.

      2. Parameter name, if specified, otherwise it is a wildcard match.

    @property _regexPathParam
    @type RegExp
    @protected
    **/
    _regexPathParam: /([:*])([\w\-]+)?/g,

    /**
    Regex that matches and captures the query portion of a URL, minus the
    preceding `?` character, and discarding the hash portion of the URL if any.

    @property _regexUrlQuery
    @type RegExp
    @protected
    **/
    _regexUrlQuery: /\?([^#]*).*$/,

    /**
    Regex that matches everything before the path portion of a URL (the origin).
    This will be used to strip this part of the URL from a string when we
    only want the path.

    @property _regexUrlOrigin
    @type RegExp
    @protected
    **/
    _regexUrlOrigin: /^(?:[^\/#?:]+:\/\/|\/\/)[^\/]*/,

    // -- Lifecycle Methods ----------------------------------------------------
    initializer: function (config) {
        var self = this;

        self._html5  = self.get('html5');
        self._routes = [];
        self._url    = self._getURL();

        // Necessary because setters don't run on init.
        self._setRoutes(config && config.routes ? config.routes :
                self.get('routes'));

        // Set up a history instance or hashchange listener.
        if (self._html5) {
            self._history       = new Y.HistoryHTML5({force: true});
            self._historyEvents =
                    Y.after('history:change', self._afterHistoryChange, self);
        } else {
            self._historyEvents =
                    Y.on('hashchange', self._afterHistoryChange, win, self);
        }

        // Fire a `ready` event once we're ready to route. We wait first for all
        // subclass initializers to finish, then for window.onload, and then an
        // additional 20ms to allow the browser to fire a useless initial
        // `popstate` event if it wants to (and Chrome always wants to).
        self.publish(EVT_READY, {
            defaultFn  : self._defReadyFn,
            fireOnce   : true,
            preventable: false
        });

        self.once('initializedChange', function () {
            Y.once('load', function () {
                setTimeout(function () {
                    self.fire(EVT_READY, {dispatched: !!self._dispatched});
                }, 20);
            });
        });
    },

    destructor: function () {
        this._historyEvents && this._historyEvents.detach();
    },

    // -- Public Methods -------------------------------------------------------

    /**
    Dispatches to the first route handler that matches the current URL, if any.

    If `dispatch()` is called before the `ready` event has fired, it will
    automatically wait for the `ready` event before dispatching. Otherwise it
    will dispatch immediately.

    @method dispatch
    @chainable
    **/
    dispatch: function () {
        this.once(EVT_READY, function () {
            this._ready = true;

            if (this._html5 && this.upgrade()) {
                return;
            } else {
                this._dispatch(this._getPath(), this._getURL());
            }
        });

        return this;
    },

    /**
    Gets the current route path, relative to the `root` (if any).

    @method getPath
    @return {String} Current route path.
    **/
    getPath: function () {
        return this._getPath();
    },

    /**
    Returns `true` if this router has at least one route that matches the
    specified URL, `false` otherwise.

    This method enforces the same-origin security constraint on the specified
    `url`; any URL which is not from the same origin as the current URL will
    always return `false`.

    @method hasRoute
    @param {String} url URL to match.
    @return {Boolean} `true` if there's at least one matching route, `false`
      otherwise.
    **/
    hasRoute: function (url) {
        if (!this._hasSameOrigin(url)) {
            return false;
        }

        url = this.removeQuery(this.removeRoot(url));

        return !!this.match(url).length;
    },

    /**
    Returns an array of route objects that match the specified URL path.

    This method is called internally to determine which routes match the current
    path whenever the URL changes. You may override it if you want to customize
    the route matching logic, although this usually shouldn't be necessary.

    Each returned route object has the following properties:

      * `callback`: A function or a string representing the name of a function
        this router that should be executed when the route is triggered.
      * `keys`: An array of strings representing the named parameters defined in
        the route's path specification, if any.
      * `path`: The route's path specification, which may be either a string or
        a regex.
      * `regex`: A regular expression version of the route's path specification.
        This regex is used to determine whether the route matches a given path.

    @example
        router.route('/foo', function () {});
        router.match('/foo');
        // => [{callback: ..., keys: [], path: '/foo', regex: ...}]

    @method match
    @param {String} path URL path to match.
    @return {Object[]} Array of route objects that match the specified path.
    **/
    match: function (path) {
        return YArray.filter(this._routes, function (route) {
            return path.search(route.regex) > -1;
        });
    },

    /**
    Removes the `root` URL from the front of _url_ (if it's there) and returns
    the result. The returned path will always have a leading `/`.

    @method removeRoot
    @param {String} url URL.
    @return {String} Rootless path.
    **/
    removeRoot: function (url) {
        var root = this.get('root');

        // Strip out the non-path part of the URL, if any (e.g.
        // "http://foo.com"), so that we're left with just the path.
        url = url.replace(this._regexUrlOrigin, '');

        if (root && url.indexOf(root) === 0) {
            url = url.substring(root.length);
        }

        return url.charAt(0) === '/' ? url : '/' + url;
    },

    /**
    Removes a query string from the end of the _url_ (if one exists) and returns
    the result.

    @method removeQuery
    @param {String} url URL.
    @return {String} Queryless path.
    **/
    removeQuery: function (url) {
        return url.replace(/\?.*$/, '');
    },

    /**
    Replaces the current browser history entry with a new one, and dispatches to
    the first matching route handler, if any.

    Behind the scenes, this method uses HTML5 `pushState()` in browsers that
    support it (or the location hash in older browsers and IE) to change the
    URL.

    The specified URL must share the same origin (i.e., protocol, host, and
    port) as the current page, or an error will occur.

    @example
        // Starting URL: http://example.com/

        router.replace('/path/');
        // New URL: http://example.com/path/

        router.replace('/path?foo=bar');
        // New URL: http://example.com/path?foo=bar

        router.replace('/');
        // New URL: http://example.com/

    @method replace
    @param {String} [url] URL to set. This URL needs to be of the same origin as
      the current URL. This can be a URL relative to the router's `root`
      attribute. If no URL is specified, the page's current URL will be used.
    @chainable
    @see save()
    **/
    replace: function (url) {
        return this._queue(url, true);
    },

    /**
    Adds a route handler for the specified URL _path_.

    The _path_ parameter may be either a string or a regular expression. If it's
    a string, it may contain named parameters: `:param` will match any single
    part of a URL path (not including `/` characters), and `*param` will match
    any number of parts of a URL path (including `/` characters). These named
    parameters will be made available as keys on the `req.params` object that's
    passed to route handlers.

    If the _path_ parameter is a regex, all pattern matches will be made
    available as numbered keys on `req.params`, starting with `0` for the full
    match, then `1` for the first subpattern match, and so on.

    Here's a set of sample routes along with URL paths that they match:

      * Route: `/photos/:tag/:page`
        * URL: `/photos/kittens/1`, params: `{tag: 'kittens', page: '1'}`
        * URL: `/photos/puppies/2`, params: `{tag: 'puppies', page: '2'}`

      * Route: `/file/*path`
        * URL: `/file/foo/bar/baz.txt`, params: `{path: 'foo/bar/baz.txt'}`
        * URL: `/file/foo`, params: `{path: 'foo'}`

    If multiple route handlers match a given URL, they will be executed in the
    order they were added. The first route that was added will be the first to
    be executed.

    @example
        router.route('/photos/:tag/:page', function (req, res, next) {
          Y.log('Current tag: ' + req.params.tag);
          Y.log('Current page number: ' + req.params.page);
        });

    @method route
    @param {String|RegExp} path Path to match. May be a string or a regular
      expression.
    @param {Function|String} callback Callback function to call whenever this
        route is triggered. If specified as a string, the named function will be
        called on this router instance.

      @param {Object} callback.req Request object containing information about
          the request. It contains the following properties.

        @param {Array|Object} callback.req.params Captured parameters matched by
          the route path specification. If a string path was used and contained
          named parameters, then this will be a key/value hash mapping parameter
          names to their matched values. If a regex path was used, this will be
          an array of subpattern matches starting at index 0 for the full match,
          then 1 for the first subpattern match, and so on.
        @param {String} callback.req.path The current URL path.
        @param {Number} callback.req.pendingRoutes Number of matching routes
          after this one in the dispatch chain.
        @param {Object} callback.req.query Query hash representing the URL query
          string, if any. Parameter names are keys, and are mapped to parameter
          values.
        @param {String} callback.req.url The full URL.
        @param {String} callback.req.src What initiated the dispatch. In an
          HTML5 browser, when the back/forward buttons are used, this property
          will have a value of "popstate".

      @param {Object} callback.res Response object containing methods and
          information that relate to responding to a request. It contains the
          following properties.
        @param {Object} callback.res.req Reference to the request object.

      @param {Function} callback.next Callback to pass control to the next
        matching route. If you don't call this function, then no further route
        handlers will be executed, even if there are more that match. If you do
        call this function, then the next matching route handler (if any) will
        be called, and will receive the same `req` object that was passed to
        this route (so you can use the request object to pass data along to
        subsequent routes).
    @chainable
    **/
    route: function (path, callback) {
        var keys = [];

        this._routes.push({
            callback: callback,
            keys    : keys,
            path    : path,
            regex   : this._getRegex(path, keys)
        });

        return this;
    },

    /**
    Saves a new browser history entry and dispatches to the first matching route
    handler, if any.

    Behind the scenes, this method uses HTML5 `pushState()` in browsers that
    support it (or the location hash in older browsers and IE) to change the
    URL and create a history entry.

    The specified URL must share the same origin (i.e., protocol, host, and
    port) as the current page, or an error will occur.

    @example
        // Starting URL: http://example.com/

        router.save('/path/');
        // New URL: http://example.com/path/

        router.save('/path?foo=bar');
        // New URL: http://example.com/path?foo=bar

        router.save('/');
        // New URL: http://example.com/

    @method save
    @param {String} [url] URL to set. This URL needs to be of the same origin as
      the current URL. This can be a URL relative to the router's `root`
      attribute. If no URL is specified, the page's current URL will be used.
    @chainable
    @see replace()
    **/
    save: function (url) {
        return this._queue(url);
    },

    /**
    Upgrades a hash-based URL to an HTML5 URL if necessary. In non-HTML5
    browsers, this method is a noop.

    @method upgrade
    @return {Boolean} `true` if the URL was upgraded, `false` otherwise.
    **/
    upgrade: function () {
        if (!this._html5) {
            return false;
        }

        // Get the full hash in all its glory!
        var hash = HistoryHash.getHash();

        if (hash && hash.charAt(0) === '/') {
            // This is an HTML5 browser and we have a hash-based path in the
            // URL, so we need to upgrade the URL to a non-hash URL. This
            // will trigger a `history:change` event, which will in turn
            // trigger a dispatch.
            this.once(EVT_READY, function () {
                this.replace(hash);
            });

            return true;
        }

        return false;
    },

    // -- Protected Methods ----------------------------------------------------

    /**
    Wrapper around `decodeURIComponent` that also converts `+` chars into
    spaces.

    @method _decode
    @param {String} string String to decode.
    @return {String} Decoded string.
    @protected
    **/
    _decode: function (string) {
        return decodeURIComponent(string.replace(/\+/g, ' '));
    },

    /**
    Shifts the topmost `_save()` call off the queue and executes it. Does
    nothing if the queue is empty.

    @method _dequeue
    @chainable
    @see _queue
    @protected
    **/
    _dequeue: function () {
        var self = this,
            fn;

        // If window.onload hasn't yet fired, wait until it has before
        // dequeueing. This will ensure that we don't call pushState() before an
        // initial popstate event has fired.
        if (!YUI.Env.windowLoaded) {
            Y.once('load', function () {
                self._dequeue();
            });

            return this;
        }

        fn = saveQueue.shift();
        return fn ? fn() : this;
    },

    /**
    Dispatches to the first route handler that matches the specified _path_.

    If called before the `ready` event has fired, the dispatch will be aborted.
    This ensures normalized behavior between Chrome (which fires a `popstate`
    event on every pageview) and other browsers (which do not).

    @method _dispatch
    @param {String} path URL path.
    @param {String} url Full URL.
    @param {String} src What initiated the dispatch.
    @chainable
    @protected
    **/
    _dispatch: function (path, url, src) {
        var self   = this,
            routes = self.match(path),
            req, res;

        self._dispatching = self._dispatched = true;

        if (!routes || !routes.length) {
            self._dispatching = false;
            return self;
        }

        req = self._getRequest(path, url, src);
        res = self._getResponse(req);

        req.next = function (err) {
            var callback, matches, route;

            if (err) {
                Y.error(err);
            } else if ((route = routes.shift())) {
                matches  = route.regex.exec(path);
                callback = typeof route.callback === 'string' ?
                        self[route.callback] : route.callback;

                // Use named keys for parameter names if the route path contains
                // named keys. Otherwise, use numerical match indices.
                if (matches.length === route.keys.length + 1) {
                    req.params = YArray.hash(route.keys, matches.slice(1));
                } else {
                    req.params = matches.concat();
                }

                req.pendingRoutes = routes.length;

                callback.call(self, req, res, req.next);
            }
        };

        req.next();

        self._dispatching = false;
        return self._dequeue();
    },

    /**
    Gets the current path from the location hash, or an empty string if the
    hash is empty.

    @method _getHashPath
    @return {String} Current hash path, or an empty string if the hash is empty.
    @protected
    **/
    _getHashPath: function () {
        return HistoryHash.getHash().replace(this._regexUrlQuery, '');
    },

    /**
    Gets the location origin (i.e., protocol, host, and port) as a URL.

    @example
        http://example.com

    @method _getOrigin
    @return {String} Location origin (i.e., protocol, host, and port).
    @protected
    **/
    _getOrigin: function () {
        var location = Y.getLocation();
        return location.origin || (location.protocol + '//' + location.host);
    },

    /**
    Gets the current route path, relative to the `root` (if any).

    @method _getPath
    @return {String} Current route path.
    @protected
    **/
    _getPath: function () {
        var path = (!this._html5 && this._getHashPath()) ||
                Y.getLocation().pathname;

        return this.removeQuery(this.removeRoot(path));
    },

    /**
    Gets the current route query string.

    @method _getQuery
    @return {String} Current route query string.
    @protected
    **/
    _getQuery: function () {
        var location = Y.getLocation(),
            hash, matches;

        if (this._html5) {
            return location.search.substring(1);
        }

        hash    = HistoryHash.getHash();
        matches = hash.match(this._regexUrlQuery);

        return hash && matches ? matches[1] : location.search.substring(1);
    },

    /**
    Creates a regular expression from the given route specification. If _path_
    is already a regex, it will be returned unmodified.

    @method _getRegex
    @param {String|RegExp} path Route path specification.
    @param {Array} keys Array reference to which route parameter names will be
      added.
    @return {RegExp} Route regex.
    @protected
    **/
    _getRegex: function (path, keys) {
        if (path instanceof RegExp) {
            return path;
        }

        // Special case for catchall paths.
        if (path === '*') {
            return (/.*/);
        }

        path = path.replace(this._regexPathParam, function (match, operator, key) {
            // Only `*` operators are supported for key-less matches to allowing
            // in-path wildcards like: '/foo/*'.
            if (!key) {
                return operator === '*' ? '.*' : match;
            }

            keys.push(key);
            return operator === '*' ? '(.*?)' : '([^/#?]*)';
        });

        return new RegExp('^' + path + '$');
    },

    /**
    Gets a request object that can be passed to a route handler.

    @method _getRequest
    @param {String} path Current path being dispatched.
    @param {String} url Current full URL being dispatched.
    @param {String} src What initiated the dispatch.
    @return {Object} Request object.
    @protected
    **/
    _getRequest: function (path, url, src) {
        return {
            path : path,
            query: this._parseQuery(this._getQuery()),
            url  : url,
            src  : src
        };
    },

    /**
    Gets a response object that can be passed to a route handler.

    @method _getResponse
    @param {Object} req Request object.
    @return {Object} Response Object.
    @protected
    **/
    _getResponse: function (req) {
        // For backwards compatibility, the response object is a function that
        // calls `next()` on the request object and returns the result.
        var res = function () {
            return req.next.apply(this, arguments);
        };

        res.req = req;
        return res;
    },

    /**
    Getter for the `routes` attribute.

    @method _getRoutes
    @return {Object[]} Array of route objects.
    @protected
    **/
    _getRoutes: function () {
        return this._routes.concat();
    },

    /**
    Gets the current full URL.

    @method _getURL
    @return {String} URL.
    @protected
    **/
    _getURL: function () {
        return Y.getLocation().toString();
    },

    /**
    Returns `true` when the specified `url` is from the same origin as the
    current URL; i.e., the protocol, host, and port of the URLs are the same.

    All host or path relative URLs are of the same origin. A scheme-relative URL
    is first prefixed with the current scheme before being evaluated.

    @method _hasSameOrigin
    @param {String} url URL to compare origin with the current URL.
    @return {Boolean} Whether the URL has the same origin of the current URL.
    @protected
    **/
    _hasSameOrigin: function (url) {
        var origin = ((url && url.match(this._regexUrlOrigin)) || [])[0];

        // Prepend current scheme to scheme-relative URLs.
        if (origin && origin.indexOf('//') === 0) {
            origin = Y.getLocation().protocol + origin;
        }

        return !origin || origin === this._getOrigin();
    },

    /**
    Joins the `root` URL to the specified _url_, normalizing leading/trailing
    `/` characters.

    @example
        router.set('root', '/foo');
        router._joinURL('bar');  // => '/foo/bar'
        router._joinURL('/bar'); // => '/foo/bar'

        router.set('root', '/foo/');
        router._joinURL('bar');  // => '/foo/bar'
        router._joinURL('/bar'); // => '/foo/bar'

    @method _joinURL
    @param {String} url URL to append to the `root` URL.
    @return {String} Joined URL.
    @protected
    **/
    _joinURL: function (url) {
        var root = this.get('root');

        url = this.removeRoot(url);

        if (url.charAt(0) === '/') {
            url = url.substring(1);
        }

        return root && root.charAt(root.length - 1) === '/' ?
                root + url :
                root + '/' + url;
    },

    /**
    Parses a URL query string into a key/value hash. If `Y.QueryString.parse` is
    available, this method will be an alias to that.

    @method _parseQuery
    @param {String} query Query string to parse.
    @return {Object} Hash of key/value pairs for query parameters.
    @protected
    **/
    _parseQuery: QS && QS.parse ? QS.parse : function (query) {
        var decode = this._decode,
            params = query.split('&'),
            i      = 0,
            len    = params.length,
            result = {},
            param;

        for (; i < len; ++i) {
            param = params[i].split('=');

            if (param[0]) {
                result[decode(param[0])] = decode(param[1] || '');
            }
        }

        return result;
    },

    /**
    Queues up a `_save()` call to run after all previously-queued calls have
    finished.

    This is necessary because if we make multiple `_save()` calls before the
    first call gets dispatched, then both calls will dispatch to the last call's
    URL.

    All arguments passed to `_queue()` will be passed on to `_save()` when the
    queued function is executed.

    @method _queue
    @chainable
    @see _dequeue
    @protected
    **/
    _queue: function () {
        var args = arguments,
            self = this;

        saveQueue.push(function () {
            if (self._html5) {
                if (Y.UA.ios && Y.UA.ios < 5) {
                    // iOS <5 has buggy HTML5 history support, and needs to be
                    // synchronous.
                    self._save.apply(self, args);
                } else {
                    // Wrapped in a timeout to ensure that _save() calls are
                    // always processed asynchronously. This ensures consistency
                    // between HTML5- and hash-based history.
                    setTimeout(function () {
                        self._save.apply(self, args);
                    }, 1);
                }
            } else {
                self._dispatching = true; // otherwise we'll dequeue too quickly
                self._save.apply(self, args);
            }

            return self;
        });

        return !this._dispatching ? this._dequeue() : this;
    },

    /**
    Saves a history entry using either `pushState()` or the location hash.

    This method enforces the same-origin security constraint; attempting to save
    a `url` that is not from the same origin as the current URL will result in
    an error.

    @method _save
    @param {String} [url] URL for the history entry.
    @param {Boolean} [replace=false] If `true`, the current history entry will
      be replaced instead of a new one being added.
    @chainable
    @protected
    **/
    _save: function (url, replace) {
        var urlIsString = typeof url === 'string';

        // Perform same-origin check on the specified URL.
        if (urlIsString && !this._hasSameOrigin(url)) {
            Y.error('Security error: The new URL must be of the same origin as the current URL.');
            return this;
        }

        // Force _ready to true to ensure that the history change is handled
        // even if _save is called before the `ready` event fires.
        this._ready = true;

        if (this._html5) {
            this._history[replace ? 'replace' : 'add'](null, {
                url: urlIsString ? this._joinURL(url) : url
            });
        } else {
            // Remove the root from the URL before it's set as the hash.
            urlIsString && (url = this.removeRoot(url));

            // The `hashchange` event only fires when the new hash is actually
            // different. This makes sure we'll always dequeue and dispatch,
            // mimicking the HTML5 behavior.
            if (url === HistoryHash.getHash()) {
                this._dispatch(this._getPath(), this._getURL());
            } else {
                HistoryHash[replace ? 'replaceHash' : 'setHash'](url);
            }
        }

        return this;
    },

    /**
    Setter for the `routes` attribute.

    @method _setRoutes
    @param {Object[]} routes Array of route objects.
    @return {Object[]} Array of route objects.
    @protected
    **/
    _setRoutes: function (routes) {
        this._routes = [];

        YArray.each(routes, function (route) {
            this.route(route.path, route.callback);
        }, this);

        return this._routes.concat();
    },

    // -- Protected Event Handlers ---------------------------------------------

    /**
    Handles `history:change` and `hashchange` events.

    @method _afterHistoryChange
    @param {EventFacade} e
    @protected
    **/
    _afterHistoryChange: function (e) {
        var self       = this,
            src        = e.src,
            prevURL    = self._url,
            currentURL = self._getURL();

        self._url = currentURL;

        // Handles the awkwardness that is the `popstate` event. HTML5 browsers
        // fire `popstate` right before they fire `hashchange`, and Chrome fires
        // `popstate` on page load. If this router is not ready or the previous
        // and current URLs only differ by their hash, then we want to ignore
        // this `popstate` event.
        if (src === 'popstate' &&
                (!self._ready || prevURL.replace(/#.*$/, '') === currentURL.replace(/#.*$/, ''))) {

            return;
        }

        self._dispatch(self._getPath(), currentURL, src);
    },

    // -- Default Event Handlers -----------------------------------------------

    /**
    Default handler for the `ready` event.

    @method _defReadyFn
    @param {EventFacade} e
    @protected
    **/
    _defReadyFn: function (e) {
        this._ready = true;
    }
}, {
    // -- Static Properties ----------------------------------------------------
    NAME: 'router',

    ATTRS: {
        /**
        Whether or not this browser is capable of using HTML5 history.

        Setting this to `false` will force the use of hash-based history even on
        HTML5 browsers, but please don't do this unless you understand the
        consequences.

        @attribute html5
        @type Boolean
        @initOnly
        **/
        html5: {
            // Android versions lower than 3.0 are buggy and don't update
            // window.location after a pushState() call, so we fall back to
            // hash-based history for them.
            //
            // See http://code.google.com/p/android/issues/detail?id=17471
            valueFn: function () { return Y.Router.html5; },
            writeOnce: 'initOnly'
        },

        /**
        Absolute root path from which all routes should be evaluated.

        For example, if your router is running on a page at
        `http://example.com/myapp/` and you add a route with the path `/`, your
        route will never execute, because the path will always be preceded by
        `/myapp`. Setting `root` to `/myapp` would cause all routes to be
        evaluated relative to that root URL, so the `/` route would then execute
        when the user browses to `http://example.com/myapp/`.

        @attribute root
        @type String
        @default `''`
        **/
        root: {
            value: ''
        },

        /**
        Array of route objects.

        Each item in the array must be an object with the following properties:

          * `path`: String or regex representing the path to match. See the docs
            for the `route()` method for more details.

          * `callback`: Function or a string representing the name of a function
            on this router instance that should be called when the route is
            triggered. See the docs for the `route()` method for more details.

        This attribute is intended to be used to set routes at init time, or to
        completely reset all routes after init. To add routes after init without
        resetting all existing routes, use the `route()` method.

        @attribute routes
        @type Object[]
        @default `[]`
        @see route
        **/
        routes: {
            value : [],
            getter: '_getRoutes',
            setter: '_setRoutes'
        }
    },

    // Used as the default value for the `html5` attribute, and for testing.
    html5: Y.HistoryBase.html5 && (!Y.UA.android || Y.UA.android >= 3)
});

/**
The `Controller` class was deprecated in YUI 3.5.0 and is now an alias for the
`Router` class. Use that class instead. This alias will be removed in a future
version of YUI.

@class Controller
@constructor
@extends Base
@deprecated Use `Router` instead.
@see Router
**/
Y.Controller = Y.Router;
