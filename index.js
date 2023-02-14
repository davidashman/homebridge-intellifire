"use strict";

let Service, Characteristic, api;

const request = require("request");
const PullTimer = require("homebridge-http-base").PullTimer;

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    api = homebridge;

    homebridge.registerPlatform("homebridge-intellifire", "Intellifire", Intellifire);
};

function Intellifire(log, config, api) {
    // store restored cached accessories here
    this.accessories = [];
    this.fireplaces = [];

    api.on('didFinishLaunching', () => {
        const jar = request.jar();
        request.post({ url: "https://iftapi.net/a//login", jar: jar}, function(e, r, b) {
            request.get({ url: "https://iftapi.net/a//enumlocations", jar: jar}, function(e, r, b) {
                let data = JSON.parse(b);
                let location_id = data.locations[0].location_id;
                request.get({ url: `https://iftapi.net/a//enumfireplaces?location_id=${location_id}`, jar: jar}, function(e, r, b) {
                    let data = JSON.parse(b);
                    data.fireplaces.forEach((f) => {
                        const uuid = this.api.hap.uuid.generate(f.serial);
                        if (!this.accessories.find(accessory => accessory.UUID === uuid)) {
                            // create a new accessory
                            const accessory = new this.api.platformAccessory(f.name, uuid);
                            const fireplace = Fireplace(log, f.name, f.serial, '1.0', accessory, jar);
                            this.fireplaces.push(fireplace);
                            api.registerPlatformAccessories('homebridge-intellifire', 'Intellifire', [accessory]);
                        }
                    });

                })
            })
        }).form({ username: config.auth.username, password: config.auth.password});
    });
}

Intellifire.prototype = {

    /**
     * REQUIRED - Homebridge will call the "configureAccessory" method once for every cached
     * accessory restored
     */
    configureAccessory: function (accessory) {
        this.accessories.push(accessory);
    }

}

function Fireplace(log, name, serialNumber, firmware_version, accessory, cookieJar) {

    this.log = log;
    this.accessory = accessory;
    this.serialNumber = serialNumber;
    this.cookieJar = cookieJar;

    const informationService = new Service.AccessoryInformation();
    informationService
        .setCharacteristic(Characteristic.Manufacturer, "Hearth and Home")
        .setCharacteristic(Characteristic.Model, "Intellifire")
        .setCharacteristic(Characteristic.SerialNumber, serialNumber)
        .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);
    accessory.addService(informationService);

    this.service = new Service.Switch(name);
    this.service.getCharacteristic(Characteristic.On)
        .on("get", this.getStatus.bind(this))
        .on("set", this.setStatus.bind(this));
    accessory.addService(this.service);

    this.pullTimer = new PullTimer(this.log, 60, this.getStatus.bind(this), value => {
        this.service.getCharacteristic(Characteristic.On).updateValue(value);
    });
    this.pullTimer.start();

    return this;
}

Fireplace.prototype = {

    getStatus: function (callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        request.get({ url: `https://iftapi.net/a/${this.serialNumber}//apppoll`, jar: this.cookieJar}, function(e, r, b) {
            this.statusCache.queried(); // we only update lastQueried on successful query
            let data = JSON.parse(b);
            callback(null, (data.power === "1"));
        });
    },

    setStatus: function (on, callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        request.post({ url: `https://iftapi.net/a/${this.serialNumber}//apppost`, jar: this.cookieJar}, function(e, r, b) {
            callback();
        }).form({power: (on ? 1 : 0)});
    },

};
