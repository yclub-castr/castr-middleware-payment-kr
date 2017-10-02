// server.js

require('dotenv').config();

const express = require('express');
const mongoDB = require('./app/db')
const bodyParser = require('body-parser');
const routes = require('./app/routes');

const app = express()
const port = process.env.PORT;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

mongoDB.connect(function (err) {
    app.use('/', routes);

    app.listen(port, () => {
        console.log('we are live on ' + port);
    });
});
