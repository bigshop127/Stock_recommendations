/**
 * errors.js — gateway 統一錯誤格式。
 *
 * 對外一律 `{ error: { code, message, detail? } }`，HTTP status 合理化：
 *   400 BAD_REQUEST / 404 NOT_FOUND|REPORT_NOT_FOUND / 502 ENGINE_ERROR /
 *   503 ENGINE_UNAVAILABLE / 504 UPSTREAM_TIMEOUT / 500 INTERNAL。
 */
'use strict';

function sendError(res, err) {
  const status = Number.isInteger(err && err.status) ? err.status : 500;
  const code = (err && err.code) || 'INTERNAL';
  const body = { error: { code, message: (err && err.message) || 'internal error' } };
  if (err && err.detail !== undefined && err.detail !== null) body.error.detail = err.detail;
  res.status(status).json(body);
}

function httpError(status, code, message, detail) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (detail !== undefined) e.detail = detail;
  return e;
}

module.exports = { sendError, httpError };
