'use strict';
import OSC from "osc";
import {
  runEntrypoint,
  InstanceBase,
  InstanceStatus,
  Regex,
} from "@companion-module/base";
import { UpgradeScripts } from "./upgrades.js";
import { ICON_SOLO } from "./icons.js";

/*
var stripDef = require('./defstrip.json');
var monDef = require('./defmons.json');
var actDef = require('./defaction.json');
var busDef = require('./defbus.json');
*/


class WingInstance extends InstanceBase {
	constructor(internal) {
		super(internal);
	}

	async init(config) {
		this.config = config;

		// this.currentSnapshot = {
		// 	name: '',
		// 	index: 0
		// };
		
		this.myMixer = {
			ip: '',
			name: '',
			model: '',
			serial: '',
			fw: ''
		};

		// mixer state
		this.xStat = {};
		// level/fader value store
		this.tempStore = {};
		// stat id from mixer address
		this.fbToStat = {};

		this.actionDefs = {};
		this.toggleFeedbacks = {};
		this.colorFeedbacks = {};
		this.variableDefs = [];
		this.soloList = new Set();
		this.fLevels = {};
		this.FADER_STEPS = 1540;
		this.fLevels[this.FADER_STEPS] = [];
		this.blinkingFB = {};
		this.blinkOn = false;
		this.crossFades = {};
		this.needStats = true;

		this.PollTimeout = 800;
		this.PollCount = 7;

	//	this.build_choices();

		// cross-fade steps per second
		this.fadeResolution = 20;

	//	this.build_strips();
	//	this.build_monitor();
	//	this.build_talk();
	//	this.init_actions();
		this.init_variables();
	//	this.init_feedbacks();
	//	this.init_presets();
		this.log("debug", Object.keys(this.xStat).length + " status addresses generated");
		this.init_osc();

	}

	// When module gets deleted
	async destroy() {
		this.log("debug", "destroy");
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			delete this.heartbeat;
		}
		if (this.blinker) {
			clearInterval(this.blinker);
			delete this.blinker;
		}
		if (this.fader) {
			clearInterval(this.fader);
			delete this.fader;
		}
		if (this.oscPort) {
			this.oscPort.close();
		}
	}

	async configUpdated(config) {
		this.init(config);
	}

	// define instance variables
	init_variables() {
		let variables = [
			{
				name: 'WING IP Address',
				variableId:  'm_ip',
			},
			{
				name: 'WING Name',
				variableId:  'm_name'
			},
			{
				name: 'WING Model',
				variableId:  'm_model'
			},
			{
				name: 'WING Serial Number',
				variableId:  'm_serial'
			},
			{
				name: 'WING Firmware',
				variableId:  'm_fw'
			// },
			// {
			// 	name: 'Current Snapshot Name',
			// 	variableId:  's_name'
			// },
			// {
			// 	name: 'Current Snapshot Index',
			// 	variableId:  's_index'
			}
		];
		variables.push.apply(variables, this.variableDefs);

		this.setVariableDefinitions(variables);
	};

	/**
	 * heartbeat to request updates, subscription expires every 10 seconds
	 */
	pulse() {
		this.sendOSC("/*s", []);
		this.log("debug", "re-subscribe");
		// any leftover status needed?
		if (this.myMixer.model == '') {
			this.sendOSC("/?", []);
		}
		if (this.needStats) {
			this.pollStats();
		}

	};

	/**
	 * blink feedbacks
	 */
	blink() {
		this.blinkOn = !this.blinkOn
		this.checkFeedbacks(...Object.keys(this.blinkingFB))
	};

	/**
	 * timed fades
	 */
	doFades() {
		let arg = { type: 'f' };
		let fadeDone = [];

		for (let f in this.crossFades) {
			let c = this.crossFades[f];
			c.atStep++;
			let atStep = c.atStep;
			let newVal = c.startVal + c.delta * atStep;
			let v = (Math.sign(c.delta)>0) ? Math.min(c.finalVal, newVal) : Math.max(c.finalVal, newVal);

			arg.value = this.faderToDB(v);

			this.sendOSC(f, arg);
			this.log("debug", f + ": " + JSON.stringify(arg));
			this.setVariableValues({
				[this.xStat[f].dvID + "_p"]: Math.round(v * 100),
				[this.xStat[f].dvID + '_d']: this.faderToDB(v,true)
			})

			if (atStep > c.steps) {
				fadeDone.push(f);
			}
		}

		// delete completed fades
		for (let f in fadeDone) {
			this.sendOSC(fadeDone[f], []); // Why?
			delete this.crossFades[fadeDone[f]];
		}
	}

	pollStats() {
		let stillNeed = false;
		let counter = 0;
		let timeNow = Date.now();
		let timeOut = timeNow - this.PollTimeout;
		let varCounter = this.varCounter;

		function ClearVars() {
			for (var id in this.xStat) {
				this.xStat[id].polled = 0;
				this.xStat[id].valid = false;
			}
		}

		let id;

		for (id in this.xStat) {
			if (!this.xStat[id].valid) {
				stillNeed = true;
				if (this.xStat[id].polled < timeOut) {
					this.sendOSC(id);
					// this.log("debug", "sending " + id);
					this.xStat[id].polled = timeNow;
					counter++;
					if (counter > this.PollCount) {
						break;
					}
				}
			}
		}

		if (this.analyzing) {
			if (varCounter < 200) {
				this.varCounter = varCounter;
			} else {
				stillNeed = false;
			}
		}

		if (!stillNeed) {
			if (this.analyzing) {
				//pause counting while resetting data
				this.needStats = false;
				var d = (timeNow - this.timeStart) / 1000;
				this.log('info', 'Pass complete (' + varCounter + '@' + (varCounter / d).toFixed(1) + ')');
				if (this.passTimeout < this.detVars.endTimeout) {
					this.passTimeout += 200;
					this.PollTimeout = this.passTimeout;
					this.varCounter = 0;
					this.timeStart = Date.now();
					stillNeed = true;
				} else if (this.passCount < this.detVars.endCount) {
					this.passTimeout = this.detVars.startTimeout;
					this.PollTimeout = this.passTimeout;
					this.passCount += 1;
					this.varCounter = 0;
					this.PollCount = this.passCount;
					this.timeStart = Date.now();
					stillNeed = true;
				} else {
					this.analyzing = false;
				}
				if (this.analyzing) {
					ClearVars();
					this.log('info', `Sync Started (${this.PollCount}/${this.PollTimeout})`);
				}
			} else {
				this.updateStatus(InstanceStatus.Ok, "Console status loaded");
				const c = Object.keys(this.xStat).length;
				const d = (timeNow - this.timeStart) / 1000;
				this.log("info", "Sync complete (" + c + "@" + (c / d).toFixed(1) + ")");
			}
		}
		this.needStats = stillNeed;
	}

	firstPoll() {
		this.timeStart = Date.now();
		this.sendOSC('/?',[]);
		this.pollStats();
		this.pulse();
	}

	stepsToFader(i, steps) {
		let res = i / ( steps - 1 );

		return Math.floor(res * 10000) / 10000;
	}

	faderToDB(f, asString) {
	// “f” represents OSC float data. f: [0.0, 1.0]
	// “d” represents the dB float data. d:[-oo, +10]

		// float Lin2db(float lin) {
		// 	if (lin <= 0.0) return -144.0;
		// 	if (lin < 0.062561095) return (lin - 0.1875) * 30. / 0.0625;
		// 	if (lin < 0.250244379) return (lin - 0.4375) / 0.00625;
		// 	if (lin < 0.500488759) return (lin - 0.6250) / 0.0125;
		// 	if (lin < 1.0) return (lin - 0.750) / 0.025;
		// 	return 10.;
		let d = 0;
		let steps = this.FADER_STEPS;

		if (f <= 0.0) {
			d = -144;
		} else if (f < 0.062561095) {
			d = (f - 0.1875) * 30.0 / 0.0625;
		} else if (f < 0.250244379) {
			d = (f - 0.4375) / 0.00625;
		} else if (f < 0.500488759) {
			d = (f - 0.6250) / 0.0125;
		} else if (f < 1.0) {
			d = (f - 0.750) / 0.025;
		} else {
			d = 10.0;
		}

		d = (Math.round(d * (steps - 0.5)) / steps)

		if (asString) {
			return (f==0 ? "-oo" : (d>=0 ? '+':'') + d.toFixed(1));
		} else {
			return d;
		}
	}

	dbToFloat(d) {
		// “d” represents the dB float data. d:[-144, +10]
		// “f” represents OSC float data. f: [0.0, 1.0]
		let f = 0;

		if (d <= -90) {
			f = 0;
		} else if (d < -60.) {
			f = (d + 90.) / 480.;
		} else if (d < -30.) {
			f = (d + 70.) / 160.;
		} else if (d < -10.) {
			f = (d + 50.) / 80.;
		} else if (d <= 10.) {
			f = (d + 30.) / 40.;
		}

		return f;

	}

	init_osc() {
		if (this.oscPort) {
			this.oscPort.close();
		}
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.ConnectionFailure, "No host IP");
		} else {
			this.oscPort = new OSC.UDPPort ({
				localAddress: "0.0.0.0",
				localPort: 0,
				remoteAddress: this.config.host,
				remotePort: 2223,
				metadata: true
			});

			// listen for incoming messages
			this.oscPort.on('message', (message, timeTag, info) => {
				const args = message.args;
				const node = message.address;
				const leaf = node.split("/").pop();
				let v = 0;

				if (!this.needStats) {
					this.log("debug", "received " + JSON.stringify(message) + " from " + JSON.stringify(info));
				}
				if (this.xStat[node] !== undefined) {
					if (args.length>1) {
						v = args[1].value;
					} else {
						v = args[0].value;
					}
					switch (leaf) {
					case 'on':
						this.xStat[node].isOn = v == 1;
						this.checkFeedbacks(this.xStat[node].fbID);
						break;
					case 'mute':
					case 'led':
					case '$solo':
						this.xStat[node].isOn = v == 1;
						if ('led' == leaf) {
							this.checkFeedbacks("col");
						}
						if ('$solo' == leaf) {
							var gs = true;
							if (v == 1){
								this.soloList.add(node);
							} else {
								this.soloList.delete(node);
								gs = this.soloList.size > 0;
							}
							this.xStat["/$stat/solo"].isOn = gs;
						}
						this.checkFeedbacks(this.xStat[node].fbID);
						break;
					case 'fdr':
					case 'lvl':
						v = Math.floor(v * 10000) / 10000;
						this.xStat[node][leaf] = v;
						this.setVariableValues({
							[this.xStat[node].dvID + "_p"]: Math.round(v * 100),
							[this.xStat[node].dvID + '_d']: this.faderToDB(v,true)
						})
						this.xStat[node].idx = this.fLevels[this.FADER_STEPS].findIndex((i) => i >= v);
						break;
					case 'name':
						// no name, use behringer default
						if (v=='') {
							v = this.xStat[node].defaultName;
						}
						if (node.match(/\/main/)) {
							v = v;
						}
						this.xStat[node].name = v;
						this.setVariableValues({
							[this.xStat[node].dvID]: v
						});
						break;
					case 'col':
						this.xStat[node].color = parseInt(args[0].value);
						this.checkFeedbacks(this.xStat[node].fbID);
						this.checkFeedbacks("led");
						break;
					case '$mono':
					case '$dim':
						this.xStat[node].isOn = v == 1;
						this.checkFeedbacks(this.xStat[node].fbID);
						break;
					default:
						if ( node.match(/\$solo/)
						|| node.match(/^\/cfg\/talk\//)
						|| node.match(/^\/\$stat\/solo/) ) {
							this.xStat[node].isOn = v == 1;
							this.checkFeedbacks(this.xStat[node].fbID);
						}
					}
					this.xStat[node].valid = true;
					this.varCounter += 1;
					if (this.needStats) {
						this.pollStats();
					} else {
						// debug(message);
					}
				} else if (leaf == '*') {
					// /?~~,s~~WING,192.168.1.71,PGM,ngc‐full,NO_SERIAL,1.07.2‐40‐g1b1b292b:develop~~~~
					let mixer_info = args[0].value.split(',');
					this.myMixer.ip = mixer_info[1];
					this.myMixer.name = mixer_info[2];
					this.myMixer.model = mixer_info[3];
					this.myMixer.serial = mixer_info[4];
					this.myMixer.fw = mixer_info[5];
					if ('WING_EMU' == mixer_info[4]) {
						this.PollTimeout = 3200;
						this.PollCount = 7;
					}
					this.setVariableValues({
						"m_ip": this.myMixer.ip,
						"m_name": this.myMixer.name,
						"m_model": this.myMixer.model,
						"m_serial": this.myMixer.serial,
						"m_fw": this.myMixer.fw
					});
				}
				else {
					this.log("debug", message.address + ": " +  JSON.stringify(args));
				}
			});

			this.oscPort.on('ready', () => {
				this.updateStatus(InstanceStatus.Connecting, "Loading console status");
				this.log("info", `Sync Started (${this.PollCount}/${this.PollTimeout})`);
				this.firstPoll();
				this.heartbeat = setInterval( () => { this.pulse(); }, 9000);
				this.blinker = setInterval( () => { this.blink(); }, 1000);
				this.fader = setInterval( () => { this.doFades(); }, 1000 / this.fadeResolution);
			});

			this.oscPort.on('close', () => {
				if (this.heartbeat) {
					clearInterval(this.heartbeat);
					delete this.heartbeat;
				}
				if (this.blinker) {
					clearInterval(this.blinker);
					delete this.blinker;
				}
				if (this.fader) {
					clearInterval(this.fader);
					delete this.fader;
				}
			});

			this.oscPort.on('error', (err) => {
				this.log('error', "Error: " + err.message);
				this.updateStatus(InstanceStatus.UnknownError, err.message)
				if (this.heartbeat) {
					clearInterval(this.heartbeat);
					delete this.heartbeat;
				}
				if (this.blinker) {
					clearInterval(this.blinker);
					delete this.blinker;
				}
				if (this.fader) {
					clearInterval(this.fader);
					delete this.fader;
				}
			});

			this.oscPort.open();
		}
	}

	sendOSC(node, arg) {
		if (this.oscPort) {
			this.oscPort.send({
				address: node,
				args: arg
			});
			this.log("debug", 'sending ' + node + (arg? arg:''));
		}
	}


  // Return config fields for web config
  getConfigFields() {
    return [
      {
        type: "textinput",
        id: "host",
        label: "Target IP",
        tooltip: "The IP of the WING console",
        width: 6,
        regex: Regex.IP,
      },
      // ,
      // {
      // 	type: 	'checkbox',
      // 	label: 	'Analyze',
      // 	id:		'analyze',
      // 	tooltip: 'Cycle through console sync timing variables\nThis will temporarily disable the module',
      // 	default: 0
      // }
    ];
  }
}

runEntrypoint(WingInstance, UpgradeScripts);

/*
instance.prototype.init_presets = function () {
	var self = this;

	var presets = [
		{
			category: 'Channels',
			label: 'Channel 1 Label\nIncludes Label, Color, Mute toggle, Mute feedback, Solo feedback',
			bank: {
				style: 'png',
				text: '$(wing:l_ch1)',
				size: '18',
				color: self.rgb(255,255,255),
				bgcolor: 0
			},
			actions: [
				{
					action: 'mute',
					options: {
						type: '/ch/',
						num: 1,
						mute: 2
					}
				}
			],
			feedbacks: [
				{
					type: 'c_ch',
					options: {
						theChannel: 1
					}
				},
				{
					type: 'ch',
					options: {
						fg: 16777215,
						bg: self.rgb(128,0,0),
						theChannel: 1
					}
				},
				{
					type: 'solosw_ch',
					options: {
						theChannel: 1
					}
				}
			]
		},
		{
			category: 'Channels',
			label: 'Channel 1 Level\nIncludes Fader dB, Color, Solo toggle, Solo feedback',
			bank: {
				style: 'png',
				text: '$(wing:f_ch1_d)',
				size: '18',
				color: self.rgb(255,255,255),
				bgcolor: 0
			},
			actions: [
				{
					action: 'solosw_ch',
					options: {
						num: 1,
						solo: 2
					}
				}
			],
			feedbacks: [
				{
					type: 'c_ch',
					options: {
						theChannel: 1
					}
				},
				{
					type: 'solosw_ch',
					options: {
						theChannel: 1
					}
				}
			]
		}
	];
	// self.setPresetDefinitions(presets);
};

instance.prototype.build_strips = function () {
	var self = this;

	var i, b;

	var stat = {};
	var fb2stat = {};
	var defVariables = [];

	function capFirst(string) {
		return string.charAt(0).toUpperCase() + string.slice(1);
	}

	function deslash(s) {
		return s.split('/').join('');
	}

	function undollar(s) {
		return s.split('$').join('_');
	}

	function cloneObject(oldObject) {
		return JSON.parse(JSON.stringify(oldObject));
	}

	var baseAct = actDef['baseActions'];
	var mgrpAct = actDef['mgrpActions'];
	var sendAct = actDef['sendActions'];
	var sendOpt = actDef['sendOptions'];

	var a, i, s, b;
	var strip, busStrip, statActs, busActs, buses, act, path, fbStatID, fbID, dvID, defaultLabel;

	// build stats & dynamic variables
	for (s in stripDef) {
		strip = stripDef[s];
		defaultLabel = strip.label + ' ';
		statActs = actDef[strip.act];
		// console.log(`action: ${strip.act}`);
		for (i = strip.min; i<= strip.max; i++) {
			for (a in statActs) {
				if (!a.match(/_/)) {	// fader has extra actions
					act = statActs[a];
					path = `/${strip.id}/${i}/${a}`;
					dvID = `${strip.id}${i}`
					fbStatID = `${strip.id}${i}_${act.fSfx}`;
					fbID = act.fSfx;
					if (act.fSfx) {
						fb2stat[fbStatID] = path;
					}
					stat[path] = {
						valid: false,
						polled: 0
					}
					switch (a) {
					case 'fdr':
						stat[path].idx = 0;
						stat[path].fdr = 0.0;
						defVariables.push({
							label: strip.description + ' ' + i + ' dB',
							name: dvID + "_d"
						});
						defVariables.push({
							label: strip.description + ' ' + i + ' %',
							name: dvID + "_p"
						});
						stat[path].dvID = dvID;
						if (strip.hasRel) {
							// add relative $fdr variable here
						}
						break;
					case 'name':
						dvID = dvID + '_' + act.vSfx;
						stat[path].defaultName = defaultLabel + i;
						stat[path].name = defaultLabel + 1;
						stat[path].dvID = dvID;
						defVariables.push( {
							label: strip.description + ' ' + i + ' ' + act.label,
							name: dvID
						});
						break;

					case 'col':
						stat[path].color = 1;
						stat[path].fbID = fbID;
						break;
					case 'icon':
						stat[path].icon = 0;
						stat[path].fbID = fbID;
						break
					case 'led':
					case '$solo':
					case 'mute':
						stat[path].isOn = false;
						stat[path].fbID = fbID;
						break;
					}
				}
			}
			buses = busDef[strip.send];
			for (b in buses){
				busStrip = stripDef[b];
				var fbIDbase = `${strip.send}_`;
				for (var bs=1; bs <= buses[b]; bs++) {
					busActs = actDef['sendOptions'];
					for (a in busActs) {
						if (!a.match('_')) {
							act = busActs[a];
							path = 	`/${strip.id}/${i}/${busStrip.sendID}${bs}/${a}`;
							fbID = fbIDbase + a;
							dvID = `${strip.id}${i}_${b}${bs}`;
							if (act.fSfx) {
								fb2stat[fbID] = path;
							}
							stat[path] = {
								valid: false,
								polled: 0
							}
							switch (a) {
							case 'lvl':
								stat[path].idx = 0;
								stat[path].lvl = 0.0;
								defVariables.push({
									label: strip.description + ' ' + i + ' to ' + busStrip.label + ' ' + bs + ' dB',
									name: dvID + "_d"
								});
								defVariables.push({
									label: strip.description + ' ' + i + ' to ' + busStrip.label + ' ' + bs + ' %',
									name: dvID + "_p"
								});
								stat[path].dvID = dvID;
								break;
							case 'on':
								stat[path].isOn = false;
								stat[path].fbID = fbID;
							}
						}
					}
				}
			}
		}
	}

	var acts = {};
	var newAct;
	var newMute;
	var newColor;
	var newOn;
	var lbl;
	var toggleFeedbacks = {};
	var colorFeedbacks = {};
	var onFeedbacks = {};

	// build channel actions
	for (var a in baseAct) {
		lbl = baseAct[a].label;
		newAct = {
			id: a,
			label: lbl,
			options: [ ]
		};
		newMute = undefined;
		newColor = undefined;
		newOn = undefined;
		if (mgrpAct[a] === undefined) {
			newAct.options.push(self.OPTIONS_STRIP_BASE);
		} else {
			newAct.options.push(self.OPTIONS_STRIP_ALL);
		}
		var newOpts = null;
		switch (baseAct[a].inType) {
		case 'fader':
			newOpts =  {
				type:	'number',
				label:	'Fader Level',
				id:		'fad',
				default: 0.0,
				min: -144,
				max: 10
			};
		case 'fader_a':
			if (newOpts === null) {
				newOpts = {
					type:	 'number',
					tooltip: 'Adjust fader +/- percent.\n0% = -oo, 75% = 0db, 100% = +10db',
					label:	 'Adjust',
					id:		 'ticks',
					min:	 -100,
					max:	 100,
					default: 1
				}
			}
		case 'fader_r':
			if (newOpts === null) {
				newOpts =  {
					type:	 'dropdown',
					tooltip: 'Recall stored fader value',
					label:	 'From',
					id:		 'store',
					default: 'me',
					choices: [
						{ 	id: 'me',
							label: "This Strip"
						},
						...self.STORE_LOCATION
					]
				}
			}
			newAct.options.push(
				newOpts,
				{
					type: 'number',
					label: 'Fade Duration (ms)',
					id: 'duration',
					default: 0,
					min: 0,
					step: 10,
					max: 60000
				});
			break;
		case 'fader_s':
			newAct.options.push( {
				type:	 'dropdown',
				tooltip: 'Store fader value for later recall',
				label:	 'Where',
				id:		 'store',
				default: 'me',
				choices: [
					{ 	id: 'me',
						label: "This Strip"
					},
					...self.STORE_LOCATION
				]
			});
			break;
		case 'color':
			newColor = cloneObject(newAct);
			newColor.id = a;
			newColor.label = 'Color of Strip';
			newColor.description = 'Set button text to Color of Strip';
			newColor.callback = function(feedback, bank) {
					var theChannel = feedback.options.strip + '/' + feedback.type;
					var stat = self.xStat[theChannel];
					return { color: self.COLOR_VALUES[stat.color - 1].fg };
				};

			newAct.options.push( {
				id: a,
				type: 'dropdown',
				label: baseAct[a].label,
				default: baseAct[a].default,
				choices: self.COLOR_VALUES
			});
			break;
		case 'led':
			newColor = cloneObject(newAct);
			newColor.id = a;
			newColor.label = 'Color on LED';
			newColor.description = 'Set button color when LED On';
			newColor.callback = function(feedback, bank) {
				var color = self.xStat[feedback.options.strip + '/col'].color;
				var stat = self.xStat[feedback.options.strip + '/led']
				if (stat.isOn) {
					return { bgcolor: self.COLOR_VALUES[color - 1].fg };
				}
			};
			newAct.options.push({
				id: 'on',
				type: 'dropdown',
				label: 'State',
				choices: self.CHOICES_ON_OFF,
				default: '1'
			});
			break;
		case 'number':
			newAct.options.push( {
				id: a,
				type: 'number',
				label: baseAct[a].label + ' ID',
				min: baseAct[a].inMin,
				max: baseAct[a].inMax,
				default: baseAct[a].default,
				range: false,
				required: true
			});
			break;
		case 'solo':
			newMute = cloneObject(newAct);
			newMute.id = a;
			newMute.label = `Show Strip ${lbl}`;
			newMute.description = `Show border if Strip is Soloed`
			newMute.callback = function(feedback, bank) {
				var theNode = feedback.options.strip + '/' + feedback.type;
				var stat = self.xStat[theNode];
				if (stat.isOn) {
					return {  png64: self.ICON_SOLO };
				}
			};
			newAct.options.push({
				id: 'on',
				type: 'dropdown',
				label: 'State',
				choices: self.CHOICES_ON_OFF,
				default: '1'
			});
			break;
		case 'onoff':
			newMute = cloneObject(newAct);
			newMute.id = a;
			newMute.label = `Color on Strip ${lbl}`;
			newMute.description = `Set button color if Strip ${lbl} is On`
			newMute.options.push(
				{
					type: 'colorpicker',
					label: 'Foreground color',
					id: 'fg',
					default: '16777215'
				},
				{
					type: 'colorpicker',
					label: 'Background color',
					id: 'bg',
					default: self.rgb(128,0, 0)
				}
			);
			newMute.callback = function(feedback, bank) {
				var theNode = feedback.options.strip + '/' + feedback.type;
				var stat = self.xStat[theNode];
				if (stat.isOn) {
					return { color: feedback.options.fg, bgcolor: feedback.options.bg };
				}
			};
			newAct.options.push({
				id: 'on',
				type: 'dropdown',
				label: 'State',
				choices: self.CHOICES_ON_OFF,
				default: '1'
			});
			break;
		case 'textinput':
			newAct.options.push( {
				id: a,
				type: 'textinput',
				label: baseAct[a].label,
				tooltip: 'Maximum ' + baseAct[a].inMax + ' characters'
			});
			break;
		}
		acts[a] = newAct;
		if (newColor) {
			colorFeedbacks[newColor.id] = newColor;
		}
		if (newMute) {
			toggleFeedbacks[newMute.id] = newMute;
		}
	}

	// build send actions
	for (a in sendAct) {
		newAct = {
			id: a,
			label: sendAct[a].label,
			options: [ ]
		};
		var st = sendAct[a].sendType;
		switch (st) {
		case 'send_bm':
			newAct.options.push(
				{
					type: 'dropdown',
					tooltip: 'Source strip',
					label: 'source',
					id: 'source',
					default: self.CHOICES_STRIP['ch'][0].id,
					choices: [
						...self.CHOICES_STRIP['ch'],
						...self.CHOICES_STRIP['aux']
					]
				},
				{
					type: 'dropdown',
					tooltip: 'Destination',
					label: 'Destination',
					id: 'bus',
					default: self.CHOICES_BUS[st][0].id,
					choices: self.CHOICES_BUS[st]
				}
			);
			break;
		case 'send_bmm':
			newAct.options.push(
				{
					type: 'dropdown',
					tooltip: 'Source bus',
					label: 'source',
					id: 'source',
					default: self.CHOICES_STRIP['bus'][0].id,
					choices: self.CHOICES_STRIP['bus']
				},
				{
					type: 'dropdown',
					tooltip: 'Destination',
					label: 'Destination',
					id: 'bus',
					default: self.CHOICES_BUS[st][0].id,
					choices: self.CHOICES_BUS[st]
				}
			);
			break;
		case 'send_m':
			newAct.options.push(
				{
					type: 'dropdown',
					tooltip: 'Source Main',
					label: 'source',
					id: 'source',
					default: self.CHOICES_STRIP['main'][0].id,
					choices: self.CHOICES_STRIP['main']
				},
				{
					type: 'dropdown',
					tooltip: 'Destination',
					label: 'Destination',
					id: 'bus',
					default: self.CHOICES_BUS[st][0].id,
					choices: self.CHOICES_BUS[st]
				}
			);
			break;
		case 'direct':
			newAct.options.push(
				{
					type: 'dropdown',
					tooltip: 'Matrix',
					label: 'Matrix',
					id: 'matrix',
					default: self.CHOICES_STRIP['mtx'][0].id,
					choices: self.CHOICES_STRIP['mtx']
				},
				{
					TYPE: 'dropdown',
					tooltip: 'Direct Input',
					label: 'Input',
					id: 'source',
					default: self.CHOICES_BUS[st][0].id,
					choices: self.CHOICES_BUS[st]
				}
			);
			break;
		}

		for (var sub in sendOpt) {
			var subAct = cloneObject(newAct);
			subAct.id = subAct.id + '_' + sub;
			subAct.label = subAct.label + ' ' + sendOpt[sub].label;
			newOpts = null;
			newOn = undefined;
			switch (sendOpt[sub].sendType) {
			case 'onoff':
				newOn = cloneObject(subAct);
				newOn.id = subAct.id;
				newOn.label = `Color on ${newAct.label} OFF`;
				newOn.description = `Set button color if ${newAct.label} is OFF`
				newOn.options.push(
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: '16777215'
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: self.rgb(128,0, 0)
					}
				);
				newOn.callback = function(feedback, bank) {
					var theNode = feedback.options.source + feedback.options.bus + '/on';
					var stat = self.xStat[theNode];
					if (!stat.isOn) {
						return { color: feedback.options.fg, bgcolor: feedback.options.bg };
					}
				};
				subAct.options.push(
					{
						id: 'on',
						type: 'dropdown',
						label: 'State',
						choices: self.CHOICES_ON_OFF,
						default: '1'
					}
				);
				break;
			case 'lvl_s':
				subAct.options.push( {
					type:	 'dropdown',
					tooltip: 'Store level for later recall',
					label:	 'Where',
					id:		 'store',
					default: 'me',
					choices: [
						{ 	id: 'me',
							label: "This Send"
						},
						...self.STORE_LOCATION
					]
				});
				break;
			case 'lvl':
				newOpts =  {
					type:	'number',
					label:	'Level',
					id:		'fad',
					default: 0.0,
					min: -144,
					max: 10
				};
				// no break
			case 'lvl_a':
				if (newOpts === null) {
					newOpts = {
						type:	 'number',
						tooltip: 'Adjust level +/- percent.\n0% = -oo, 75% = 0db, 100% = +10db',
						label:	 'Adjust',
						id:		 'ticks',
						min:	 -100,
						max:	 100,
						default: 1
					}
				}
				// no break
			case 'lvl_r':
				if (newOpts === null) {
					newOpts =  {
						type:	 'dropdown',
						tooltip: 'Recall stored value',
						label:	 'From',
						id:		 'store',
						default: 'me',
						choices: [
							{ 	id: 'me',
								label: "This Send"
							},
							...self.STORE_LOCATION
						]
					}
				}
				subAct.options.push(
					newOpts,
					{
						type: 'number',
						label: 'Fade Duration (ms)',
						id: 'duration',
						default: 0,
						min: 0,
						step: 10,
						max: 60000
					});
				break;
			}
			acts[subAct.id] = subAct;
			if (newOn) {
				onFeedbacks[newOn.id] = newOn;
			}
		}
	}

	self.xStat = stat;
	self.variableDefs = defVariables;
	self.actionDefs = acts;
	self.fbToStat = fb2stat;
	self.colorFeedbacks = colorFeedbacks;
	self.toggleFeedbacks = toggleFeedbacks;
	Object.assign(self.toggleFeedbacks, onFeedbacks);

};

instance.prototype.build_monitor = function () {
	var self = this;
	var c, i, ch, cm, cMap, id, actID, soloID, cmd, pfx;

	var stat = {};
	var fb2stat = self.fbToStat;
	var soloActions = {};
	var soloFeedbacks = {};

	var def = monDef;

	for (id in def) {
		cmd = def[id];
		pfx = cmd.prefix;
		cMap = cmd.cmdMap;
		for (cm in cmd.cmdMap) {
			ch = cMap[cm];
			actID = 'solo_' + ch.actID;
			soloID = 'f_solo';
			c = pfx + ch.actID;
			stat[c] = {
				fbID: actID,
				varID: soloID,
				valid: false,
				polled: 0
			};
			fb2stat[actID] = c;
			soloActions[actID] = {
				label: "Solo " + ch.description,
				options: []
			};
			soloActions[actID].options.push( {
				type:	'dropdown',
				label:	'Value',
				id:		'set',
				default: '2',
				choices: [
					{id: '1', label: 'On'},
					{id: '0', label: 'Off'},
					{id: '2', label: 'Toggle'}
				]
			} );
			stat[c].isOn = false;
			soloFeedbacks[actID] = {
				label: 		 "Solo Bus" + ch.description + " on",
				description: "Color on Solo Bus" + ch.description,
				options: [
					{
						type: 'colorpicker',
						label: 'Foreground color',
						id: 'fg',
						default: '16777215'
					},
					{
						type: 'colorpicker',
						label: 'Background color',
						id: 'bg',
						default: self.rgb.apply(this, ch.bg)
					},
				],
				callback: function(feedback, bank) {
					var fbType = feedback.type;
					var stat = self.xStat[fb2stat[fbType]];
					if (stat.isOn) {
						return { color: feedback.options.fg, bgcolor: feedback.options.bg };
					}
				}
			};
		}
	}
	actID = 'clearsolo';
	soloID = '/$stat/solo'
	soloActions[actID] = {
		label: 'Solo Clear',
		description: 'Clear all active Solos',
		options: []
	};
	stat[soloID] = {
		fbID: actID,
		isOn: false,
		valid: false,
		polled: 0
	};
	self.fbToStat[actID] = soloID;
	soloFeedbacks[actID] = {
		label: 		 'Any Solo Active',
		options: [
			{
				type: 	'checkbox',
				label: 	'Blink?',
				id:		'blink',
				default: 0
			},
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: 0
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(168, 168, 0)
			},
		],
		callback: function(feedback, bank) {
			var opt = feedback.options;
			var fbType = feedback.type;
			var stat = self.xStat[self.fbToStat[fbType]];

			if (stat.isOn) {
				if (opt.blink) {		// wants blink
					self.blinkingFB[stat.fbID] = true;
					if(!self.blinkOn) {
						return
					}
				}
				return { color: opt.fg, bgcolor: opt.bg };
			} else {
				delete self.blinkingFB[stat.fbID];
			}

		}
	};

	Object.assign(self.xStat, stat);
	Object.assign(self.actionDefs, soloActions);
	Object.assign(self.toggleFeedbacks, soloFeedbacks);
};

instance.prototype.build_talk = function () {
	var self = this;
	var basePfx = '/cfg/talk/'
	var baseID = 'talk';
	var talkActions = {};
	var stat = {};
	var talkFeedbacks = {};
	var newAct;
	var newFB;

	var talkBus =	{
		id: 'bus',
		type: 'dropdown',
		label: 'Bus',
		default: 'A',
		choices: [
			{ id: 'A', label: 'Talkback A' },
			{ id: 'B', label: 'Talkback B' }
		]
	}

	var talkDest = {
		id: 'dest',
		type: 'dropdown',
		label: 'Destination',
		choices: []
	}

	for (var bus of ['A','B']) {
		stat[basePfx + bus + '/$on'] = {
			fbID: baseID,
			isOn: false,
			polled: 0,
			valid: false
		}
		for (var n=1; n<=16; n++) {
			var dest = 'B' + n;
			stat[basePfx + bus + '/' + dest ] ={
				fbID: baseID + '_d',
				isOn: false,
				polled: 0,
				valid: false
			};
			if ('A' == bus) {
				talkDest.choices.push({
					id: dest,
					label: 'Bus ' + n
				});
			}
		}
		for (var n=1; n<=4; n++) {
			var dest = 'M' + n;
			stat[basePfx + bus + '/' + dest ] = {
				fbID: baseID + '_d',
				isOn: false,
				polled: 0,
				valid: false
			};
			if ('A' == bus) {
				talkDest.choices.push({
					id: dest,
					label: 'Main ' + n
				});
			}
		}
	}

	talkDest.default = 'B1';

	// TB A/B on/off
	newAct = {
		id:	'talk',
		label: 'Talkback',
		description: 'Turn Talkback On/Off',
		options: [
			talkBus,
			{
				id: 'on',
				type: 'dropdown',
				label: 'State',
				default: '1',
				choices: self.CHOICES_ON_OFF
			}
		]
	}

	talkActions[newAct.id] = newAct;
	newAct = {
		id:	'talk_d',
		label: 'Talkback Destination',
		description: 'Enable Talkback Destination',
		options: [
			talkBus,
			talkDest,
			{
				id: 'on',
				type: 'dropdown',
				label: 'State',
				default: '1',
				choices: self.CHOICES_ON_OFF
			}
		]
	}
	talkActions[newAct.id] = newAct;

	var newFB = {
		id: 'talk',
		label: 'Color for Talkback On',
		options: [
			talkBus,
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: '16777215'
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(128, 0, 0)
			}
		],
		callback: function(feedback, bank) {
			var theNode = '/cfg/talk/' + feedback.options.bus + '/$on';
			var stat = self.xStat[theNode];
			if (stat.isOn) {
				return { color: feedback.options.fg, bgcolor: feedback.options.bg };
			}
		}
	}

	talkFeedbacks[newFB.id] = newFB;

	newFB = {
		id: 'talk_d',
		label: 'Color for Talkback Destination On',
		options: [
			talkBus,
			talkDest,
			{
				type: 'colorpicker',
				label: 'Foreground color',
				id: 'fg',
				default: '16777215'
			},
			{
				type: 'colorpicker',
				label: 'Background color',
				id: 'bg',
				default: self.rgb(0 , 102, 0)
			}
		],
		callback: function(feedback, bank) {
			var theNode = '/cfg/talk/' + feedback.options.bus + '/' + feedback.options.dest;
			var stat = self.xStat[theNode];
			if (stat.isOn) {
				return { color: feedback.options.fg, bgcolor: feedback.options.bg };
			}
		}
	};

	talkFeedbacks[newFB.id] = newFB;

	Object.assign(self.xStat, stat);
	Object.assign(self.actionDefs, talkActions);
	Object.assign(self.toggleFeedbacks, talkFeedbacks);
};

// define instance feedbacks
instance.prototype.init_feedbacks = function() {
	var self = this;

	var feedbacks = {
		// snap_color: {
		// 	label: 'Color on Current Snapshot',
		// 	description: 'Set Button colors when this Snapshot is loaded',
		// 	options: [
		// 		{
		// 			type: 'colorpicker',
		// 			label: 'Foreground color',
		// 			id: 'fg',
		// 			default: '16777215'
		// 		},
		// 		{
		// 			type: 'colorpicker',
		// 			label: 'Background color',
		// 			id: 'bg',
		// 			default: self.rgb(0, 128, 0)
		// 		},
		// 		{
		// 			type: 'number',
		// 			label: 'Snapshot to match',
		// 			id: 'theSnap',
		// 			default: 1,
		// 			min: 1,
		// 			max: 64,
		// 			range: false,
		// 			required: true
		// 		}
		// 	],
		// 	callback: function(feedback, bank) {
		// 		if (feedback.options.theSnap == self.currentSnapshot.index) {
		// 			return { color: feedback.options.fg, bgcolor: feedback.options.bg };
		// 		}
		// 	}
		// }
	};
	Object.assign(feedbacks,this.toggleFeedbacks);
	Object.assign(feedbacks,this.colorFeedbacks);
	this.setFeedbackDefinitions(feedbacks);
};

instance.prototype.build_choices = function() {
	var self = this;
	var strips;
	var buses;
	var bMax;

	// discreet float values for faders (1540)
	for (var i = 0; i < self.FADER_STEPS; i++) {
		self.fLevels[self.FADER_STEPS][i] = self.stepsToFader(i,self.FADER_STEPS);
	}

	self.STORE_LOCATION = [];

	for (var i = 1; i <=10; i++) {
		var i2 = ('0' + i.toString()).slice(-2);

		self.STORE_LOCATION.push( {
			label: `Global ${i}`,
			id: `gs_${i2}`
		})
	}

	self.CHOICES_ON_OFF = [
		{id: '1', label: 'On'},
		{id: '0', label: 'Off'},
		{id: '2', label: 'Toggle'}
	]

	strips = {
		type:     'dropdown',
		label:    'Strip',
		id:       'strip',
		choices:  [	],
		default:  ''
	};

	self.CHOICES_STRIP = {};

	for (var d in stripDef) {
		var s = stripDef[d];
		self.CHOICES_STRIP[d] = [];
		for (var i = s.min; i <= s.max; i++) {
			self.CHOICES_STRIP[d].push( {
				id: '/' + s.id + '/' + i,
				label: s.label + ' ' + i
			});
		}
	}

	for (var d in stripDef) {
		var s = stripDef[d];
		for (var i=s.min; i <= s.max; i++) {
			if (s.act == 'baseActions') {
				strips.choices.push( {
					id: '/' + s.id + '/' + i,
					label: s.label + ' ' + i
				});
			}
		}
	}

	strips.default = strips.choices[0].id;

	self.OPTIONS_STRIP_BASE = { ...strips };

	strips.choices = [];
	for (var d in stripDef) {
		var s = stripDef[d];
		for (var i=s.min; i <= s.max; i++) {
			strips.choices.push( {
				id: '/' + s.id + '/' + i,
				label: s.label + ' ' + i
			});
		}
	}

	self.OPTIONS_STRIP_ALL = { ...strips };

	self.CHOICES_BUS = {};

	for (var b in busDef) {
		var bus = busDef[b];
		self.CHOICES_BUS[b] = [];
		for (var d in bus) {
			var s = stripDef[d];
			for (var i=1; i<=bus[d]; i++) {
				self.CHOICES_BUS[b].push( {
					id: '/' + s.sendID +  i,
					label: s.label + ' ' + i
				});
			}
		}
	}

	self.FADER_VALUES = [
		{ label: '- ∞',        id: '0.0' },
		{ label: '-50 dB: ',   id: '0.1251' },
		{ label: '-30 dB',     id: '0.251' },
		{ label: '-20 dB',     id: '0.375' },
		{ label: '-18 dB',     id: '0.4' },
		{ label: '-15 dB',     id: '0.437' },
		{ label: '-12 dB',     id: '0.475' },
		{ label: '-9 dB',      id: '0.525' },
		{ label: '-6 dB',      id: '0.6' },
		{ label: '-3 dB',      id: '0.675' },
		{ label: '-2 dB',      id: '0.7' },
		{ label: '-1 dB',      id: '0.725' },
		{ label: '0 dB',       id: '0.75' },
		{ label: '+1 dB',      id: '0.775' },
		{ label: '+2 dB',      id: '0.8' },
		{ label: '+3 dB',      id: '0.825' },
		{ label: '+4 dB',      id: '0.85' },
		{ label: '+5 dB',      id: '0.875' },
		{ label: '+6 dB',      id: '0.9' },
		{ label: '+9 dB',      id: '0.975' },
		{ label: '+10 dB',     id: '1.0' }
	];

	self.COLOR_VALUES = [
		{ label: 'Gray blue',	id: '1',	fg: self.rgb(162, 224, 235) },
		{ label: 'Medium blue',	id: '2',	fg: self.rgb( 64, 242, 252) },
		{ label: 'Dark blue',	id: '3',	fg: self.rgb( 64, 181, 235) },
		{ label: 'Turquoise',	id: '4',	fg: self.rgb( 36, 252, 237) },
		{ label: 'Green',		id: '5',	fg: self.rgb(  1, 242,  49) },
		{ label: 'Olive green',	id: '6',	fg: self.rgb(197, 223,  61) },
		{ label: 'Yellow',		id: '7',	fg: self.rgb(254, 242,   0) },
		{ label: 'Orange',		id: '8',	fg: self.rgb(252, 141,  51) },
		{ label: 'Red',			id: '9',	fg: self.rgb(252,  50,  50) },
		{ label: 'Coral',		id: '10',	fg: self.rgb(254, 145, 104) },
		{ label: 'Pink',		id: '11',	fg: self.rgb(251, 161, 249) },
		{ label: 'Mauve',		id: '12',	fg: self.rgb(161, 141, 254) }
	];

	self.TAPE_FUNCTIONS = [
		{ label: 'STOP',                id: '0' },
		{ label: 'PLAY PAUSE',          id: '1' },
		{ label: 'PLAY',                id: '2' },
		{ label: 'RECORD PAUSE',        id: '3' },
		{ label: 'RECORD',              id: '4' },
		{ label: 'FAST FORWARD',        id: '5' },
		{ label: 'REWIND',              id: '6' }
	];
}

instance.prototype.init_actions = function(system) {
	var self = this;
	var newActions = {};

	Object.assign(newActions, self.actionDefs);

	self.setActions(newActions);
};

instance.prototype.action = function(action) {
	var self = this;
	var cmd;
	var subAct = action.action.slice(-2);
	var opt = action.options;
	var fVal;
	var needEcho = true;
	var arg = [];

	// calculate new fader/level float
	// returns a 'new' float value
	// or undefined for store or crossfade
	function fadeTo(cmd, opt) {
		var stat = self.xStat[cmd]
		var node = cmd.split('/').pop();
		var opTicks = parseInt(opt.ticks);
		var steps = self.FADER_STEPS;
		var span = parseFloat(opt.duration);
		var oldVal = stat[node];
		var oldIdx = stat.idx;
		var byVal = opTicks * steps / 100;
		var newIdx = Math.min(steps-1,Math.max(0, oldIdx + Math.round(byVal)));
		var slot = opt.store == 'me' ? cmd : opt.store;
		var r, byVal, newIdx;

		switch (subAct) {
			case '_a':			// adjust +/- (pseudo %)
				byVal = opTicks * steps / 100;
				newIdx = Math.min(steps-1,Math.max(0, oldIdx + Math.round(byVal)));
				r = self.fLevels[steps][newIdx];
			break;
			case '_r':			// restore
				r = slot && self.tempStore[slot] !== undefined ? self.tempStore[slot] : -1;
			break;
			case '_s':			// store
				if (slot) {		// sanity check
					self.tempStore[slot] = stat[node];
				}
				r = undefined;
				// the 'store' actions are internal to this module only
				// r is left undefined since there is nothing to send
			break;
			default:			// set new value
				r = self.dbToFloat(opt.fad);
		}
		// set up cross fade?
		if (span>0 && r >= 0) {
			var xSteps = span / (1000 / self.fadeResolution);
			var xDelta = Math.floor((r - oldVal) / xSteps * 10000) / 10000;
			if (xDelta == 0) { // already there
				r = undefined;
			} else {
				self.crossFades[cmd] = {
					steps: xSteps,
					delta: xDelta,
					startVal: oldVal,
					finalVal: r,
					atStep: 1
				}
				// start the xfade
				r = oldVal + xDelta;
				needEcho = false;
			}
		}
		self.debug(`---------- ${oldIdx}:${oldVal} by ${byVal}(${opTicks}) fadeTo ${newIdx}:${r} ----------`);
		if (r !== undefined) {
			r = self.faderToDB(r)
		}
		return r;
	}

	// internal function for action (not anonymous)
	// self is properly scoped to next outer closure
	function setToggle(cmd, opt) {
		return 2 == parseInt(opt) ? (1-(self.xStat[cmd].isOn ? 1 : 0)) : parseInt(opt);
	}

	switch (action.action){

		case 'mute':
			cmd = opt.strip + '/mute';
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			};
		break;

		case 'fdr':
		case 'fdr_a':
		case 'fdr_s':
		case 'fdr_r':
			cmd = opt.strip + '/fdr';
			if ((fVal = fadeTo(cmd, opt)) === undefined) {
				cmd = undefined;
			} else {
				arg = {
					type: 'f',
					value: fVal
				};
			}
		break;

		case 'send_bm_on':
		case 'send_bmm_on':
		case 'send_m_on':
			cmd = opt.source + opt.bus + '/on';
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			};
		break;

		case 'send_bm_lvl':
		case 'send_bmm_lvl':
		case 'send_m_lvl':
		case 'send_bm_lvl_a':
		case 'send_bmm_lvl_a':
		case 'send_m_lvl_a':
		case 'send_bm_lvl_s':
		case 'send_bmm_lvl_s':
		case 'send_m_lvl_s':
		case 'send_bm_lvl_r':
		case 'send_bmm_lvl_r':
		case 'send_m_lvl_r':
			cmd = opt.source + opt.bus + '/lvl';
			if ((fVal = fadeTo(cmd, opt)) === undefined) {
				cmd = undefined;
			} else {
				arg = {
					type: 'f',
					value: fVal
				};
			}
		break;

		// don't have details for this, yet
		 // It's probably in mon/1..2/level
		 
		// case 'solo_level':
		// case 'solo_level_a':
		// 	cmd = '/config/solo/level';
		// 	if ((fVal = fadeTo(cmd, opt)) < 0) {
		// 		cmd = undefined;
		// 	} else {
		// 		arg = {
		// 			type: 'f',
		// 			value: fVal
		// 		};
		// 	}
		// break;

		case '$solo':
			cmd = opt.strip + '/$solo';
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			};

		break;

		case 'led':
			cmd = opt.strip + '/led';
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			};
		break;

		case 'name':
			arg = {
				type: "s",
				value: "" + opt.name
			};
			cmd = opt.strip + '/name';
		break;

		case 'col':
			arg = {
				type: 'i',
				value: parseInt(opt.col)
			};
			cmd = opt.strip + '/col';
		break;

		case 'icon':
			arg = {
				type: 'i',
				value: parseInt(opt.icon)
			};
			cmd = opt.strip + '/icon';
		break;

		case 'solo_mute':
		case 'solo_$dim':
		case 'solo_$mono':
			var cfg = action.action.split('_')[1]
			cmd = '/cfg/solo/' + cfg;
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.set)
			};
		break;

		case 'talk':
			cmd = '/cfg/talk/' + opt.bus + '/$on'
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			}
		break;

		case 'talk_d':
			cmd = '/cfg/talk/' + opt.bus + '/' + opt.dest;
			arg = {
				type: 'i',
				value: setToggle(cmd, opt.on)
			}
		break;

		case 'clearsolo':
			// WING does not have this as a command
			// so we keep track of 'solos' to reset each one
			for (var s of self.soloList) {
				self.sendOSC(s, {type: 'i', value: 0 });
				self.sendOSC(s,[]);
			}

		break;

		// case 'load_snap':
		// 	arg = {
		// 		type: 'i',
		// 		value: parseInt(opt.snap)
		// 	};
		// 	cmd = '/-snap/load';
		// break;

		// case 'tape':
		// 	arg = {
		// 		type: 'i',
		// 		value: parseInt(opt.tFunc)
		// 	};
		// 	cmd = '/-stat/tape/state';
		// break;
	}

	if (cmd !== undefined) {
		self.sendOSC(cmd,arg);
		self.debug(cmd, arg);
		// force a reply
		if (needEcho) {
			self.sendOSC(cmd,[]);
		}
	}
};
*/