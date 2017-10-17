// app/routes.js

'use strict';

const express = require('express');
const iamport_router = require('./iamport/iamport.route');
const payout_router = require('./payout/payout.route');
const mc_router = require('./menucast/mc.route');

const router = express.Router();

router.get('/', (req, res) => {
    res.send('It\'s alive!!!');
});

router.use('/payment', iamport_router);
router.use('/payout', payout_router);
router.use('/menucast', mc_router);

module.exports = router;
