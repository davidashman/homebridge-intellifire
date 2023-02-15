"use strict";

import {fetch, CookieJar} from 'node-fetch-cookies';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

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
        this.local = true;

        this.api.on('didFinishLaunching', () => {
            this.login.then(() => {
                this.registerFireplaces();
            })
        })
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
        let data = await r.json();
        let location_id = data.locations[0].location_id;

        this.log.info("Discovering fireplaces...");
        r = await fetch(this.cookieJar, `https://iftapi.net/a//enumfireplaces?location_id=${location_id}`);
        data = await r.json();
        this.log.info(`Found ${data.fireplaces.length} fireplaces.`);

        data.fireplaces.forEach((f) => {
            const uuid = this.api.hap.uuid.generate(f.serial);
            if (this.accessories.find(accessory => accessory.UUID === uuid)) {
                this.log.info(`Skipping ${f.name}...`);
            }
            else {
                this.log.info(`Registering ${f.name}...`);

                // create a new accessory
                const accessory = new this.api.platformAccessory(f.name, uuid);
                accessory.context.fireplaceName = f.name;
                accessory.context.serialNumber = f.serial;
                accessory.context.apiKey = f.apikey;
                accessory.addService(new Service.Switch(accessory.context.fireplaceName));

                this.log.info(`Creating fireplace for ${accessory.context.fireplaceName} with serial number ${accessory.context.serialNumber} and UUID ${accessory.UUID}.`);
                this.fireplaces.push(new Fireplace(this.log, accessory, this.cookieJar, this.local));

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
            if (accessory.context.apiKey) {
                if (!this.fireplaces.find(fireplace => fireplace.serialNumber === accessory.context.serialNumber)) {
                    this.log.info(`Creating fireplace for existing accessory ${accessory.context.fireplaceName} with serial number ${accessory.context.serialNumber} and UUID ${accessory.UUID}.`);
                    this.fireplaces.push(new Fireplace(this.log, accessory, this.cookieJar));
                }
            }
            else {
                this.api.unregisterPlatformAccessories('homebridge-intellifire', 'Intellifire', [accessory]);
            }
        })
    }

}

class Fireplace {

    constructor(log, accessory, cookieJar, local) {
        this.log = log;
        this.accessory = accessory;
        this.cookieJar = cookieJar;
        this.name = accessory.context.fireplaceName;
        this.serialNumber = accessory.context.serialNumber;
        this.power = false;
        this.local = local;
        this.apiKeyBuffer = Buffer.from(accessory.context.apiKey);
        this.userId = cookieJar.cookies.get('iftapi.net').get('user').value;

        this.service = accessory.getService(Service.Switch);
        this.service.getCharacteristic(Characteristic.On)
            .on("get", (callback) => {
                callback(null, this.power);
            })
            .on("set", (value, callback) => {
                this.setStatus(value, callback);
            });

        this.queryStatus((e, v) => { this.log.info(`Initial status: ${v}`)});
        this.pullTimer = new http.PullTimer(log, 60000, (callback) => {
            this.pullTimer.resetTimer();
            this.queryStatus(callback);
        }, value => {
            this.service.getCharacteristic(Characteristic.On).updateValue(value);
        });
        this.pullTimer.start();
    }

    queryStatus(callback) {
        this.log.info(`Querying for status on ${this.name}.`);
        if (this.local) {
            fetch(this.cookieJar, `http://192.168.1.188/poll`).then((response) => {
                this.log(`Response from Intellifire: ${response.statusText}`);
                response.json().then((data) => {
                    this.log(`Status response: ${data.power === "0" ? "off" : "on"}`);
                    this.power = (data.power === "1");
                    callback(null, this.power);
                })
            });
        }
        else {
            fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppoll`).then((response) => {
                this.log(`Response from Intellifire: ${response.statusText}`);
                response.json().then((data) => {
                    this.log(`Status response: ${data.power === "0" ? "off" : "on"}`);
                    this.power = (data.power === "1");
                    callback(null, this.power);
                })
            });
        }
    }

    setStatus(on, callback) {
        if (this.local) {
            fetch(this.cookieJar, `http://192.168.1.188/get_challenge`)
                .then((response) => {
                    if (response.ok) {
                        response.text().then(challenge => {
                            const challengeBuffer = Buffer.from(challenge, 'hex');
                            const payloadBuffer = Buffer.from(`power=(on ? "1" : "0"))`);
                            const sig = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, challengeBuffer, payloadBuffer])).digest();
                            const resp = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, sig])).digest('hex');

                            const params = new URLSearchParams();
                            params.append("command", "power");
                            params.append("value", (on ? "1" : "0"));
                            params.append("user", this.userId);
                            params.append("response", resp);

                            fetch(this.cookieJar, 'http://192.168.1.188/post', {
                                method: 'POST',
                                body: params
                            }).then(response => {
                                this.power = on;
                                this.log.info(`Fireplace ${this.name} power changed to ${on}`);
                                response.text().then((text) => { this.log.info(`Fireplace update response: ${text}`) });
                                callback();
                            })
                        });
                    }
                    else {
                        this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
                        callback(response.statusText);
                    }
                });
        }
        else {
            const params = new URLSearchParams();
            params.append("power", (on ? "1" : "0"));

            fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppost`, {
                method: "POST",
                body: params
            }).then((response) => {
                if (response.ok) {
                    this.power = on;
                    this.log.info(`Fireplace ${this.name} power changed to ${on}: ${response.statusText}`);
                    response.text().then((text) => { this.log.info(`Fireplace update response: ${text}`) });
                    callback();
                }
                else {
                    this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
                    callback(response.statusText);
                }
            });
        }
    }

}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-intellifire", "Intellifire", IntellifirePlatform);
}

export default platform;