import Base_state_class from './../../core/base-state.js';

var instance = null;

class Edit_undo_class {

	constructor() {
		//singleton
		if (instance) {
			return instance;
		}
		instance = this;

		this.Base_state = new Base_state_class();
		this.events();
	}

	events(){
		var _this = this;

		document.querySelector('#undo_button').addEventListener('click', function (event) {
			_this.Base_state.undo();
		});

		// Redo used to be keyboard-only (Ctrl+Y); expose it so a human can click it during
		// the shared-editing acceptance flow.
		document.querySelector('#redo_button')?.addEventListener('click', function (event) {
			_this.Base_state.redo();
		});
	}

	undo() {
		this.Base_state.undo();
	}
}

export default Edit_undo_class;
