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
                const accessory = new this.api.platformAccessory(`${f.name} Fireplace`, uuid);
                accessory.context.fireplaceName = f.name;
                accessory.context.serialNumber = f.serial;
                accessory.context.apiKey = f.apikey;
                accessory.addService(new Service.Switch(`${f.name} Fireplace`));
                accessory.addService(new Service.Lightbulb(`${f.name} Fireplace`));
                // accessory.addService(new Service.Fan(`${f.name} Fireplace`));

                this.log.info(`Creating fireplace for ${accessory.context.fireplaceName} with serial number ${accessory.context.serialNumber} and UUID ${accessory.UUID}.`);
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
            if (accessory.context.apiKey) {
                this.accessories.push(accessory);
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

    constructor(log, accessory, cookieJar, localIP) {
        this.log = log;
        this.accessory = accessory;
        this.cookieJar = cookieJar;
        this.name = accessory.context.fireplaceName;
        this.serialNumber = accessory.context.serialNumber;
        this.localIP = localIP;
        this.apiKeyBuffer = Buffer.from(accessory.context.apiKey);
        this.userId = cookieJar.cookies.get('iftapi.net').get('user').value;

        const power = accessory.getService(Service.Switch);
        power.getCharacteristic(Characteristic.On)
            // .on("get", (callback) => {
            //     callback(null, this.power);
            // })
            .onSet((value) => {
                this.setPower(value);
            });

        const height = accessory.getService(Service.Lightbulb);
        height.getCharacteristic(Characteristic.Brightness)
            // .on("get", (callback) => {
            //     callback(null, this.power);
            // })
            .onSet((value) => {
                this.setHeight(value);
            })
            .setProps({
                minValue: 1,
                maxValue: 5,
                minStep: 1
            })
            .updateValue(1);

        this.queryStatus();

        setInterval(() => {
            this.queryStatus();
        }, 60000);
    }

    updateStatus(data) {
        this.accessory.getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Hearth and Home')
            .setCharacteristic(Characteristic.Model, data.brand)
            .setCharacteristic(Characteristic.FirmwareRevision, data.firmware_version_string)
            .setCharacteristic(Characteristic.SerialNumber, this.serialNumber);

        this.accessory.getService(Service.Switch)
            .getCharacteristic(Characteristic.On)
            .updateValue(data.power === "1");

        this.accessory.getService(Service.Lightbulb)
            .getCharacteristic(Characteristic.Brightness)
            .updateValue(parseInt(data.height));
    }

    queryStatus() {
        this.log.info(`Querying for status on ${this.name}.`);
        if (this.localIP) {
            fetch(this.cookieJar, `http://${this.localIP}/poll`).then((response) => {
                this.log(`Response from Intellifire: ${response.statusText}`);
                response.json().then((data) => {
                    this.log(`Status response: ${JSON.stringify(data)}`);
                    this.updateStatus(data);
                })
            });
        }
        else {
            fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppoll`).then((response) => {
                this.log(`Response from Intellifire: ${response.statusText}`);
                response.json().then((data) => {
                    this.log(`Status response: ${JSON.stringify(data)}`);
                    this.updateStatus(data);
                })
            });
        }
    }

    setStatus(command, value) {
        if (this.localIP) {
            fetch(this.cookieJar, `http://${this.localIP}/get_challenge`)
                .then((response) => {
                    if (response.ok) {
                        response.text().then(challenge => {
                            const challengeBuffer = Buffer.from(challenge, 'hex');
                            const payloadBuffer = Buffer.from(`${command}=${value})`);
                            const sig = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, challengeBuffer, payloadBuffer])).digest();
                            const resp = createHash('sha256').update(Buffer.concat([this.apiKeyBuffer, sig])).digest('hex');

                            const params = new URLSearchParams();
                            params.append("command", command);
                            params.append("value", value);
                            params.append("user", this.userId);
                            params.append("response", resp);

                            fetch(this.cookieJar, 'http://${this.localIP}/post', {
                                method: 'POST',
                                body: params
                            }).then(response => {
                                this.power = on;
                                this.log.info(`Fireplace update response: ${response.status}`);
                            })
                        });
                    }
                    else {
                        this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
                    }
                });
        }
        else {
            const params = new URLSearchParams();
            params.append(command, value);

            fetch(this.cookieJar, `https://iftapi.net/a/${this.serialNumber}//apppost`, {
                method: "POST",
                body: params
            }).then((response) => {
                if (response.ok) {
                    this.power = on;
                    this.log.info(`Fireplace update response: ${response.status}`);
                }
                else {
                    this.log.info(`Fireplace ${this.name} power failed to update: ${response.statusText}`);
                }
            });
        }
    }

    setPower(on) {
        this.setStatus("power", (on ? "1" : "0"));
    }

    setHeight(value) {
        this.setStatus("height", value.toString());
    }
}

const platform = (api) => {
    Service = api.hap.Service;
    Characteristic = api.hap.Characteristic;
    api.registerPlatform("homebridge-intellifire", "Intellifire", IntellifirePlatform);
}

export default platform;