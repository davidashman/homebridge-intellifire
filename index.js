"use strict";

import request from "request";
import PullTimer from "homebridge-http-base";

class IntellifirePlatform {

    constructor(log, config, api) {
        // store restored cached accessories here
        this.accessories = [];
        this.fireplaces = [];
        this.log = log;
        this.config = config;
        this.api = api;
        this.cookieJar = request.jar();

        api.on('didFinishLaunching', () => {
            this.registerFireplaces();
        });
    }

    registerFireplaces() {
        request.post({ url: "https://iftapi.net/a//login", jar: this.cookieJar}, (e, r, b) => {
            request.get({ url: "https://iftapi.net/a//enumlocations", jar: this.cookieJar}, (e, r, b) => {
                let data = JSON.parse(b);
                let location_id = data.locations[0].location_id;
                request.get({ url: `https://iftapi.net/a//enumfireplaces?location_id=${location_id}`, jar: this.cookieJar}, (e, r, b) => {
                    let data = JSON.parse(b);
                    data.fireplaces.forEach((f) => {
                        const uuid = this.api.hap.uuid.generate(f.serial);
                        if (!this.accessories.find(accessory => accessory.UUID === uuid)) {
                            // create a new accessory
                            const accessory = new this.api.platformAccessory(f.name, uuid);
                            this.log.debug(`Registering fireplae ${f.name} with serial ${f.serial}`);
                            const fireplace = new Fireplace(this.api, this.log, f.name, f.serial, '1.0', accessory, this.cookieJar);
                            this.fireplaces.push(fireplace);
                            this.api.registerPlatformAccessories('homebridge-intellifire', 'Intellifire', [accessory]);
                        }
                    });
                })
            })
        }).form({ username: this.config.username, password: this.config.password});
    }

    /**
     * REQUIRED - Homebridge will call the "configureAccessory" method once for every cached
     * accessory restored
     */
    configureAccessory(accessory) {
        this.accessories.push(accessory);
    }

}

class Fireplace {

    constructor(api, log, name, serialNumber, firmware_version, accessory, cookieJar) {
        this.log = log;
        this.accessory = accessory;
        this.serialNumber = serialNumber;
        this.cookieJar = cookieJar;
        this.api = api;

        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;

        const informationService = new this.Service.AccessoryInformation();
        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Hearth and Home")
            .setCharacteristic(Characteristic.Model, "Intellifire")
            .setCharacteristic(Characteristic.SerialNumber, serialNumber)
            .setCharacteristic(Characteristic.FirmwareRevision, firmware_version);
        accessory.addService(informationService);

        this.service = new this.Service.Switch(name);
        this.service.getCharacteristic(this.Characteristic.On)
            .on("get", this.getStatus)
            .on("set", this.setStatus);
        accessory.addService(this.service);

        this.pullTimer = new PullTimer(this.log, 60, this.getStatus, value => {
            this.service.getCharacteristic(this.Characteristic.On).updateValue(value);
        });
        this.pullTimer.start();
    }

    getStatus(callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        request.get({ url: `https://iftapi.net/a/${this.serialNumber}//apppoll`, jar: this.cookieJar}, (e, r, b) => {
            let data = JSON.parse(b);
            callback(null, (data.power === "1"));
        });
    }

    setStatus(on, callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        request.post({ url: `https://iftapi.net/a/${this.serialNumber}//apppost`, jar: this.cookieJar}, (e, r, b) => {
            callback();
        }).form({power: (on ? 1 : 0)});
    }

};

const platform = (api) => {
    api.registerPlatform("homebridge-intellifire", "Intellifire", IntellifirePlatform);
}
export default platform;
