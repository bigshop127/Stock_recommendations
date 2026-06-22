/**
 * routes/market.js — Market routes gateway (Phase 1).
 *
 * Forwards market API requests to the Python engine.
 */
'use strict';

const express = require('express');
const { engineGet } = require('../lib/engine');
const { sendError } = require('../lib/errors');

const router = express.Router();

// TWSE queries can be slow, 60s timeout
const T_MARKET = 60000;

router.get('/api/market/indices', async (req, res) => {
  const { range } = req.query;
  try {
    const data = await engineGet('/market/indices', { range }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/breadth', async (req, res) => {
  const { date } = req.query;
  try {
    const data = await engineGet('/market/breadth', { date }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/sectors', async (req, res) => {
  const { date } = req.query;
  try {
    const data = await engineGet('/market/sectors', { date }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/api/market/institutional', async (req, res) => {
  const { date, days } = req.query;
  try {
    const data = await engineGet('/market/institutional', { date, days }, T_MARKET);
    res.json(data);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
