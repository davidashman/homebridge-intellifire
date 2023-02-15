"use strict";

import {fetch, CookieJar} from 'node-fetch-cookies';
import http from "homebridge-http-base";

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
        this.cookieJar = new CookieJar();
        this.login = this._login();

        this.api.on('didFinishLaunching', () => {
            this.login.then(() => {
                this.registerFireplaces();
            })
        })

        //         // this.api.on('didFinishLaunching', this.registerFireplaces);
        //         this.registerFireplaces();
        // await rp.post({url: "https://iftapi.net/a//login", jar: this.cookieJar, form: {username: this.config.username, password: this.config.password}})
        //     .then((r) => {
        //         this.log.info(`Logged in with response ${r.statusCode}.`)
        //         // this.api.on('didFinishLaunching', this.registerFireplaces);
        //         this.registerFireplaces();
        //     })
        // })
    }

    async _login() {
        this.log.info("Logging into Intellifire...");

        const loginParams = new URLSearchParams();
        loginParams.append('username', this.config.username);
        loginParams.append('password', this.config.password);

        let r = await fetch(this.cookieJar, "https://iftapi.net/a//login", {
            method: "POST",
            body: loginParams
        });
        this.log.info(`Logged in with response ${r.status}.`);
    }

    async registerFireplaces() {
        this.log.info("Discovering locations...");
        let r = await fetch(this.cookieJar, "https://iftapi.net/a//enumlocations");
        let data = r.json();
        this.log.info(data);
        let location_id = data.locations[0].location_id;

        this.log.info("Discovering fireplaces...");
        r = await fetch(this.cookieJar, `https://iftapi.net/a//enumfireplaces?location_id=${location_id}`);
        data = r.json();
        this.log.info(data);
        this.log.info(`Found ${data.fireplaces.length} fireplaces.`);

        data.fireplaces.forEach((f) => {
            this.log.info(`Registering ${f.name}...`);
            const uuid = this.api.hap.uuid.generate(f.serial);
            if (!this.accessories.find(accessory => accessory.UUID === uuid)) {
                // create a new accessory
                const accessory = new this.api.platformAccessory(f.name, uuid);
                accessory.context.fireplaceName = f.name;
                accessory.context.serialNumber = f.serial;
                accessory.context.firmwareVersion = '1.0';
                accessory.addService(new Service.Switch(accessory.context.fireplaceName));

                this.log.info(`Creating fireplace for ${accessory.context.fireplaceName}.`);
                this.fireplaces.push(new Fireplace(this.log, accessory, this.cookieJar));

                this.log.info(`Registering fireplace ${accessory.context.fireplaceName} with serial ${accessory.context.serialNumber}`);
                this.api.registerPlatformAccessories('homebridge-intellifire', 'Intellifire', [accessory]);
            }
        });
    }

    /**
     * REQUIRED - Homebridge will call the "configureAccessory" method once for every cached
     * accessory restored
     */
    configureAccessory(accessory) {
        this.login.then(() => {
            this.accessories.push(accessory);
            this.log.info(`Creating fireplace for ${accessory.context.fireplaceName}.`);
            this.fireplaces.push(new Fireplace(this.log, accessory, this.cookieJar));
        })
    }

}

class Fireplace {

    constructor(log, accessory, cookieJar) {
        this.accessory = accessory;
        this.cookieJar = cookieJar;
        this.name = accessory.context.fireplaceName;
        this.serialNumber = accessory.context.serialNumber;

        const service = accessory.getService(Service.Switch);
        service.getCharacteristic(Characteristic.On)
            .on("get", this.getStatus)
            .on("set", this.setStatus);

        this.pullTimer = new http.PullTimer(log, 60, this.getStatus, value => {
            service.getCharacteristic(Characteristic.On).updateValue(value);
        });
        this.pullTimer.start();
    }

    getStatus(callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        this.log.info(`Querying for status on ${this.name}.`);

        fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppoll`).then((r) => {
            callback(null, (r.json().power === "1"));
        })
        // request.get({url: `https://iftapi.net/a/${this.serialNumber}//apppoll`, jar: this.cookieJar}, (e, r, b) => {
        //     let data = JSON.parse(b);
        //     callback(null, (data.power === "1"));
        // });
    }

    setStatus(on, callback) {
        if (this.pullTimer)
            this.pullTimer.resetTimer();

        const params = new URLSearchParams();
        params.append("power", (on ? 1 : 0));
        fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppost`, {
            method: "POST",
            body: params
        }).then(() => {
            callback();
        });

        // request.post({url: `https://iftapi.net/a/${this.serialNumber}//apppost`, jar: this.cookieJar}, (e, r, b) => {
        //     callback();
        // }).form({power: (on ? 1 : 0)});
    }

}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-intellifire", "Intellifire", IntellifirePlatform);
}

export default platform;