// app/menucast/mc.service.js

'use strict';

const mongoDB = require('../db');
const constants = require('../constants');
const logger = require('../utils').logger();
const moment = require('../utils').moment();

const payment_type = constants.payment_type;
const status_type = constants.status_type;

class MenucastService {
    /**
     * Payout service class constructor.
     */
    constructor() {
        return null;
    }

    couponRedeemHook(req, res) {
        // Find promotable from 'promotions.promoTable'
        const business_id = req.params.business_id;
        const promotable_id = req.params.promotable_id;
        const name = {
            short: null,
            long: `Menucast coupon redeem [#${business_id}] - ${promotable_id}`,
            long_kr: `메뉴캐스트 쿠폰 사용 [#${business_id}] - ${promotable_id}`,
        };

        mongoDB.getDB().collection('mc-transactions').insertOne({
            business_id: business_id,
            mc_customer_id: req.body.mc_customer_id,
            type: payment_type.mc_redeem,
            name: name,
            promotable_name: req.body.promotable_name,
            currency: 'KRW',
            amount: req.body.amount,
            perc_disc_applied: req.body.discount,
            status: status_type.redeemed,
            time_redeemed: new Date(),
            time_created: new Date(),
        })
            .then(() => {
                const msg = `Coupon redeem for promotable (#${promotable_id}) successfully saved to DB`;
                logger.debug(msg);
                res.send({
                    success: true,
                    message: msg,
                });
            })
            .catch((err) => {
                logger.error(err.message);
                res.send({
                    success: false,
                    message: err.message,
                });
            });
    }
}

module.exports = new MenucastService();
