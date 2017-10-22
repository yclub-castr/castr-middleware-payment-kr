// server.js

'use strict';

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mongoDB = require('./app/db');
const logger = require('./app/utils').logger();
const routes = require('./app/routes');
const iamportService = require('./app/iamport/iamport.service');
const payoutService = require('./app/payout/payout.service');

const app = express();
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(cors());

mongoDB.connect((db_error) => {
    // Log incoming requests
    app.use((req, res, next) => {
        logger.debug('# INCOMING REQUEST');
        logger.debug(`# ${req.method} ${req.originalUrl}`);
        next();
    });

    app.use('/', routes);

    iamportService.initialize();
    payoutService.initialize();

    app.listen(port, () => {
        logger.debug(`we are live on ${port}`);
    });
});
