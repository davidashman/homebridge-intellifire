"use strict";

import request from "request";
import PullTimer from "homebridge-http-base";

let Service;
let Characteristic;

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
                            accessory.context.serialNumber = f.serial;
                            accessory.context.firmwareVersion = '1.0';

                            const informationService = new Service.AccessoryInformation();
                            informationService
                                .setCharacteristic(Characteristic.Manufacturer, "Hearth and Home")
                                .setCharacteristic(Characteristic.Model, "Intellifire")
                                .setCharacteristic(Characteristic.SerialNumber, accessory.context.serialNumber)
                                .setCharacteristic(Characteristic.FirmwareRevision, accessory.context.firmwareVersion);
                            accessory.addService(informationService);
                            accessory.addService(new Service.Switch(accessory.name));

                            this.log.debug(`Registering fireplae ${accessory.name} with serial ${accessory.context.serialNumber}`);
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
        this.fireplaces.push(new Fireplace(this.log, accessory, this.cookieJar));
    }

}

class Fireplace {

    constructor(log, accessory, cookieJar) {
        this.accessory = accessory;
        this.cookieJar = cookieJar;

        const service = accessory.getService(Service.Switch);
        service.getCharacteristic(Characteristic.On)
            .on("get", this.getStatus)
            .on("set", this.setStatus);

        this.pullTimer = new PullTimer(log, 60, this.getStatus, value => {
            service.getCharacteristic(Characteristic.On).updateValue(value);
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
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-intellifire", "Intellifire", IntellifirePlatform);
}
export default platform;
