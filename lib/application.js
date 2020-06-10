
'use strict';

/**
 * Module dependencies.
 */

const isGeneratorFunction = require('is-generator-function');
const debug = require('debug')('koa:application');
const onFinished = require('on-finished');
const response = require('./response');
const compose = require('koa-compose');
const context = require('./context');
const request = require('./request');
const statuses = require('statuses');
const Emitter = require('events');
const util = require('util');
const Stream = require('stream');
const http = require('http');
const only = require('only');
const convert = require('koa-convert');
const deprecate = require('depd')('koa');
const { HttpError } = require('http-errors');

/**
 * Expose `Application` class.
 * Inherits from `Emitter.prototype`.
 */

module.exports = class Application extends Emitter {
  /**
   * Initialize a new `Application`.
   *
   * @api public
   */

  /**
    *
    * @param {object} [options] Application options
    * @param {string} [options.env='development'] Environment
    * @param {string[]} [options.keys] Signed cookie keys
    * @param {boolean} [options.proxy] Trust proxy headers
    * @param {number} [options.subdomainOffset] Subdomain offset
    * @param {boolean} [options.proxyIpHeader] proxy ip header, default to X-Forwarded-For
    * @param {boolean} [options.maxIpsCount] max ips read from proxy ip header, default to 0 (means infinity)
    *
    */

  constructor(options) {
    super();

    options = options || {};

    // 代理设置，为 true 时获取真正的客户端的 IP 地址
    this.proxy = options.proxy || false;

    // 子域名的偏移设置
    this.subdomainOffset = options.subdomainOffset || 2;

    // 代理头设置
    this.proxyIpHeader = options.proxyIpHeader || 'X-Forwarded-For';

    // 从代理读取到的请求 IP 最大数量
    this.maxIpsCount = options.maxIpsCount || 0;

    // 环境变量
    this.env = options.env || process.env.NODE_ENV || 'development';

    // cookie 的标识
    if (options.keys) this.keys = options.keys;

    // 中间件存储数组
    this.middleware = [];

    // koa 的核心对象
    this.context = Object.create(context);
    this.request = Object.create(request);
    this.response = Object.create(response);

    if (util.inspect.custom) {
      this[util.inspect.custom] = this.inspect;
    }
  }

  /**
   * Shorthand for:
   *
   *    http.createServer(app.callback()).listen(...)
   *
   * @param {Mixed} ...
   * @return {Server}
   * @api public
   */

  listen(...args) {
    debug('listen');
    const server = http.createServer(this.callback());
    return server.listen(...args);
  }

  /**
   * Return JSON representation.
   * We only bother showing settings.
   *
   * @return {Object}
   * @api public
   */

  toJSON() {
    return only(this, [
      'subdomainOffset',
      'proxy',
      'env'
    ]);
  }

  /**
   * Inspect implementation.
   *
   * @return {Object}
   * @api public
   */

  inspect() {
    return this.toJSON();
  }

  /**
   * Use the given middleware `fn`.
   *
   * Old-style middleware will be converted.
   *
   * @param {Function} fn
   * @return {Application} self
   * @api public
   */

  use(fn) {
    // 传入参数必须为函数
    if (typeof fn !== 'function') throw new TypeError('middleware must be a function!');

    // generator 兼容处理
    if (isGeneratorFunction(fn)) {
      deprecate('Support for generators will be removed in v3. ' +
                'See the documentation for examples of how to convert old middleware ' +
                'https://github.com/koajs/koa/blob/master/docs/migration.md');
      fn = convert(fn);
    }

    debug('use %s', fn._name || fn.name || '-');

    // 将中间件函数存入数组
    this.middleware.push(fn);
    return this;
  }

  /**
   * Return a request handler callback
   * for node's native http server.
   *
   * @return {Function}
   * @api public
   */

  callback() {
    // 通过 koa-compose 组合中间件
    const fn = compose(this.middleware);

    // 如果没有对 error 进行监听则监听 error 事件
    if (!this.listenerCount('error')) this.on('error', this.onerror);

    // handleRequest 就是上面 listen 中的 http.createServer 的回调函数。
    // 有 req 和 res 两个参数，代表原生的 request, response 对象
    const handleRequest = (req, res) => {
      // 每次接受一个新的请求就是生成一次全新的 context
      // 创建一个新的 context 对象，建立 koa 中 context、request、response 属性之间和原生 http 对象的关系
      // 然后将创建的 ctx 对象带入中间件函数们中执行
      const ctx = this.createContext(req, res);
      return this.handleRequest(ctx, fn);
    };

    return handleRequest;
  }

  /**
   * Handle request in callback.
   *
   * @api private
   */

  handleRequest(ctx, fnMiddleware) {
    // 默认为 404 响应
    const res = ctx.res;
    res.statusCode = 404;

    // error 监听函数
    const onerror = err => ctx.onerror(err);

    // 响应处理函数
    const handleResponse = () => respond(ctx);

    // 为 res 对象添加错误处理响应，当 res 响应结束时，执行 context 中的 onerror 函数
    // 这里需要注意区分 context 与 koa 实例中的onerror
    onFinished(res, onerror);

    // 执行中间件数组中的所有函数，并结束时调用上面的respond函数
    return fnMiddleware(ctx).then(handleResponse).catch(onerror);
  }

  /**
   * Initialize a new context.
   *
   * @api private
   */

  createContext(req, res) {
    const context = Object.create(this.context);
    const request = context.request = Object.create(this.request);
    const response = context.response = Object.create(this.response);
    context.app = request.app = response.app = this;
    context.req = request.req = response.req = req;
    context.res = request.res = response.res = res;
    request.ctx = response.ctx = context;
    request.response = response;
    response.request = request;
    context.originalUrl = request.originalUrl = req.url;
    context.state = {};
    return context;
  }

  /**
   * Default error handler.
   *
   * @param {Error} err
   * @api private
   */

  onerror(err) {
    if (!(err instanceof Error)) throw new TypeError(util.format('non-error thrown: %j', err));

    if (404 === err.status || err.expose) return;
    if (this.silent) return;

    const msg = err.stack || err.toString();
    console.error();
    console.error(msg.replace(/^/gm, '  '));
    console.error();
  }
};

/**
 * Response helper.
 */

function respond(ctx) {
  // allow bypassing koa
  if (false === ctx.respond) return;

  // writable 是原生的node的response对象上的 writable 属性，其作用是用于检查是否是可写流
  if (!ctx.writable) return;

  const res = ctx.res;
  let body = ctx.body;
  const code = ctx.status;

  // ignore body
  // statuses是一个模块方法，用于判断响应的 statusCode 是否属于 body 为空的类型。
  // 例如：204,205,304，此时将 body 置为null
  if (statuses.empty[code]) {
    // strip headers
    ctx.body = null;
    return res.end();
  }

  // 如果是 HEAD 方法
  if ('HEAD' === ctx.method) {
    // headersSent 属性是Node原生的 response对象上的，用于检查 http 响应头是否已经被发送
    // 如果没有被发送，那么添加 length 头部
    if (!res.headersSent && !ctx.response.has('Content-Length')) {
      const { length } = ctx.response;
      if (Number.isInteger(length)) ctx.length = length;
    }
    return res.end();
  }

  // status body
  // 如果 body 为 null
  if (null == body) {

    // httpVersionMajor 是 node 原生对象 response 上的一个属性，用于返回当前 http 的版本，这里是对 http2 版本以上做的一个兼容
    if (ctx.response._explicitNullBody) {
      ctx.response.remove('Content-Type');
      ctx.response.remove('Transfer-Encoding');
      return res.end();
    }

    if (ctx.req.httpVersionMajor >= 2) {
      body = String(code);
    } else {
      body = ctx.message || String(code);
    }

    // headersSent 也是原生属性，为 ture 表示响应头已经被发送
    // 如果响应报文头还没有被发送出去，就为 ctx 添加一个 length 属性，length 属性记录这当前报文主体 body 的字节长度
    if (!res.headersSent) {
      ctx.type = 'text';
      ctx.length = Buffer.byteLength(body);
    }

    return res.end(body);
  }

  // responses
  // 对 body 为 Buffer 类型的进行处理
  if (Buffer.isBuffer(body)) return res.end(body);

  // 对 body 为字符串类型的进行处理
  if ('string' === typeof body) return res.end(body);

  // 对 body 为流类型的进行处理，是流的话合并
  if (body instanceof Stream) return body.pipe(res);

  // body: json
  // 最后将为 Json 格式的 body 进行字符串处理，将其转化成字符串
  // 同时添加 length 头部信息
  body = JSON.stringify(body);
  if (!res.headersSent) {
    ctx.length = Buffer.byteLength(body);
  }
  res.end(body);
}

/**
 * Make HttpError available to consumers of the library so that consumers don't
 * have a direct dependency upon `http-errors`
 */
module.exports.HttpError = HttpError;
