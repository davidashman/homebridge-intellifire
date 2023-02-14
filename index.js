"use strict";

let Service, Characteristic, api;

const request = require("request");
const _http_base = require("homebridge-http-base");
const http = _http_base.http;
const configParser = _http_base.configParser;
const PullTimer = _http_base.PullTimer;
const notifications = _http_base.notifications;
const MQTTClient = _http_base.MQTTClient;
const Cache = _http_base.Cache;
const utils = _http_base.utils;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    api = homebridge;

    homebridge.registerAccessory("homebridge-intellifire", "Fireplace", Fireplace);
};

function Fireplace(log, config) {
    this.log = log;
    this.name = config.name;
    this.debug = config.debug || false;

    this.timeout = config.timeout;
    if (typeof this.timeout !== 'number') {
        this.timeout = 1000;
    }

    this.statusCache = new Cache(config.statusCache, 0);
    if (config.statusCache && typeof config.statusCache !== "number")
        this.log.warn("Property 'statusCache' was given in an unsupported type. Using default one!");
    }

    let jar = request.jar();
    request.post({ url: "https://iftapi.net/a//login", jar: jar}, function(e, r, b) {
        request.get({ url: "https://iftapi.net/a//enumlocations", jar: jar}, function(e, r, b) {
            let data = JSON.parse(b);
            let location_id = data.locations[0].location_id;
            request.get({ url: `https://iftapi.net/a//enumfireplaces?location_id=${location_id}`, jar: jar}, function(e, r, b) {
                let data = JSON.parse(b);
                this.serialNumber = data.fireplaces[0].serial;
                request.get({ url: `https://iftapi.net/a/${this.serialNumber}//apppoll`, jar: jar}, function(e, r, b) {
                    this.statusCache.queried(); // we only update lastQueried on successful query
                    let data = JSON.parse(b);
                    this.firmwareVersion = data.firmware_version;
                });
            })
        })
    }).form({ username: config.auth.username, password: config.auth.password});
    this.cookieJar = jar;

    this.homebridgeService = new Service.Switch(this.name);
    const onCharacteristic = this.homebridgeService.getCharacteristic(Characteristic.On)
        .on("get", this.getStatus.bind(this))
        .on("set", this.setStatus.bind(this));

    this.pullTimer = new PullTimer(this.log, config.pullInterval || 60, this.getStatus.bind(this), value => {
        this.homebridgeService.getCharacteristic(Characteristic.On).updateValue(value);
    });
    this.pullTimer.start();
}

Fireplace.prototype = {

    identify: function (callback) {
        this.log("Identify requested!");
        callback();
    },

    getServices: function () {
        if (!this.homebridgeService)
            return [];

        const informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Hearth and Home")
            .setCharacteristic(Characteristic.Model, "Intellifire")
            .setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
            .setCharacteristic(Characteristic.FirmwareRevision, 1);

        return [informationService, this.homebridgeService];
    },

    /** @namespace body.characteristic */
    handleNotification: function(body) {
        const value = body.value;

        let characteristic;
        switch (body.characteristic) {
            case "On":
                characteristic = Characteristic.On;
                break;
            default:
                this.log("Encountered unknown characteristic handling notification: " + body.characteristic);
                return;
        }

        if (this.debug)
            this.log("Updating '" + body.characteristic + "' to new value: " + body.value);

        if (this.pullTimer)
            this.pullTimer.resetTimer();

        this.homebridgeService.getCharacteristic(characteristic).updateValue(value);
    },

    getStatus: function (callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        if (!this.statusCache.shouldQuery()) {
            const value = this.homebridgeService.getCharacteristic(Characteristic.On).value;
            if (this.debug)
                this.log(`getStatus() returning cached value '${value? "ON": "OFF"}'${this.statusCache.isInfinite()? " (infinite cache)": ""}`);
            callback(null, value);
            break;
        }

        if (this.debug)
            this.log("getStatus() doing http request...");

        request.get({ url: `https://iftapi.net/a/${this.serialNumber}//apppoll`, jar: jar}, function(e, r, b) {
            this.statusCache.queried(); // we only update lastQueried on successful query
            let data = JSON.parse(b);
            callback(null, (data.power === "1"));
        });
    },

    setStatus: function (on, callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        this._makeSetRequest(on, callback);
    },

    _makeSetRequest: function (on, callback) {
        request.post({ url: `https://iftapi.net/a/${this.serialNumber}//apppost`, jar: jar}, function(e, r, b) {
            callback();
        }).form({power: (on ? 1 : 0)});
    },

};
