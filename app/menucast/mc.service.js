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
        mongoDB.getDB().collection('promotions').findOne({ promoTable: { $elemMatch: { _id: mongoDB.ObjectId(promotable_id) } } })
            .then((promotion) => {
                let promotable_name;
                let amount;
                let perc_disc_applied;
                promotion.promoTable.forEach((promotable) => {
                    if (promotable._id.toString() === promotable_id) {
                        promotable_name = promotable.nameOne;
                        amount = (promotable.price * (1 - (promotable.discount / 100))).toFixed(0);
                        perc_disc_applied = promotable.discount;
                    }
                });
                const name = {
                    short: null,
                    long: `Menucast coupon redeem [#${business_id}] - ${promotable_name}`,
                    long_kr: `메뉴캐스트 쿠폰 사용 [#${business_id}] - ${promotable_name}`,
                };
                return mongoDB.getDB().collection('mc-transactions').insertOne({
                    business_id: business_id,
                    promotable_id: promotable_id,
                    promotable_name: promotable_name,
                    mc_customer_id: req.body.mc_customer_id,
                    type: payment_type.mc_redeem,
                    name: name,
                    currency: 'KRW',
                    amount: amount,
                    perc_disc_applied: perc_disc_applied,
                    status: status_type.redeemed,
                    time_created: new Date(),
                });
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
