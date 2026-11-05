import config from './../../config.js';
import Helper_class from './../../libs/helpers.js';
import Translate_class from './../../libs/jquery.translate.js';
import alertify from './../../../../node_modules/alertifyjs/build/alertify.min.js';

var instance = null;

class Tools_translate_class {

	constructor() {
		//singleton
		if (instance) {
			return instance;
		}
		instance = this;

		this.Helper = new Helper_class();
		this.translations = {};
		this.trans_lang_codes = [];

		this.load_translations();
		// Native notifications do not carry .trn markup. Translate their string
		// arguments at the same i18n boundary as menus and dialogs.
		for (const method of ['error', 'success', 'warning', 'message']) {
			const original = alertify[method].bind(alertify);
			alertify[method] = (message, ...args) => original(this.translate_message(message), ...args);
		}
	}

	translate_message(message) {
		if (typeof message !== 'string' || config.LANG === 'en') return message;
		const trimmed = message.trim();
		const exact = this.translations[trimmed]?.[config.LANG];
		if (exact) return exact;
		// A few native errors append a layer id or filename to a translated prefix.
		for (const key of Object.keys(this.translations)) {
			if (key.endsWith(':') && trimmed.startsWith(key)) {
				const translated = this.translations[key][config.LANG];
				if (translated) return translated + trimmed.slice(key.length);
			}
		}
		return message;
	}

	//change language
	translate(lang_code, element) {
		if (lang_code == undefined) {
			lang_code = this.Helper.getCookie('language');
			if (!lang_code) {
				return;
			}
		}

		if (lang_code != undefined && lang_code != config.LANG) {
			//save cookie
			this.Helper.setCookie('language', lang_code);
		}

		if (this.trans_lang_codes.includes(lang_code) || lang_code == 'en') {
			//translate
			$(element || 'body').translate({lang: lang_code, t: this.translations});
			config.LANG = lang_code;
		}
		else {
			alertify.error('Translate error, can not find dictionary: ' + lang_code);
		}
	}

	load_translations() {
		var _this = this;
		var modules_context = require.context("./../../languages/", true, /\.json$/);
		modules_context.keys().forEach(function (key) {
			if (key.indexOf('Base' + '/') < 0 && key.indexOf('empty') < 0) {
				var moduleKey = key.replace('./', '').replace('.json', '');
				var classObj = modules_context(key);
				
				for(var i in classObj){
					if(_this.translations[i] == undefined){
						_this.translations[i] =	{
							en: i,
						};
					}
					_this.translations[i][moduleKey] = classObj[i];
				}
				_this.trans_lang_codes.push(moduleKey);
			}
		});
	}
}

export default Tools_translate_class;
