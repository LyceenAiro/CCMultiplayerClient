export class LoadScreenHook {
	public displayServers(servers: string[],
		loadMenu: () => void): Promise<number> {
		return new Promise((resolve) => {
			this.hook(function(this: LoadScreenHook, box: sc.ButtonListBox) {
				box.clear();

				this.clearHandlers(box);
				this.addHandler(box, (button: sc.SaveSlotButton) => {
					// `autoSlotMiss.text` is a localized text object in 1.4.x;
					// coerce to a plain string for comparison.
					resolve(servers.indexOf(String(button.autoSlotMiss.text)));
				});

				for (let i = 0; i < servers.length; i++) {
					this.addButton(box, servers[i]);
				}
			}.bind(this));

			loadMenu();
		}) ;
	}

	public hook(callback: (box: sc.ButtonListBox) => void): void {
		const original = sc.ButtonListBox.prototype.activate;
		sc.ButtonListBox.prototype.activate = function(this: sc.ButtonListBox, ...args: any) {
			const result = original.apply(this, args);
			callback(this);
			sc.ButtonListBox.prototype.activate = original;
			return result;
		};
	}

	public addButton(box: sc.ButtonListBox, name: string) {
		// slot must be -1 (the "new game / no save" slot). In 1.4.2 the title-screen
		// highlight (SaveSlotButtonHighlight.setSlot) dereferences
		// `ig.storage.getSlot(slot).data` for any slot != -1; with slot 0 that throws
		// "Cannot read property 'data' of undefined" whenever there is no save in
		// that slot (e.g. a fresh profile). -1 keeps it on the autoSlotMiss branch,
		// which simply shows our server name.
		const button = new sc.SaveSlotButton(undefined, -1);
		button.autoSlotMiss.setText(name);

		box.addButton(button, false);
	}

	private clearHandlers(box: sc.ButtonListBox): void {
		box.buttonGroup.pressCallbacks = [];
		box.buttonGroup.selectionCallbacks = [];
	}

	private addHandler(box: sc.ButtonListBox, callback: (button: sc.SaveSlotButton) => void) {
		box.buttonGroup.pressCallbacks.push((button) => callback(button as sc.SaveSlotButton));
	}
}