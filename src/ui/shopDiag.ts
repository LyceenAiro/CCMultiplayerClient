/**
 * ROUND 123 (diagnostics): 联机模式下部分商人"打开购买/出售小框后点击购买无反应"。
 * 静态分析已排除：商店数据、模组对商店/菜单/交易的直接 hook、暂停抑制（菜单 GUI
 * 为 pauseGui，未暂停也能更新）、购买结算路径（buyItems 不依赖暂停）。
 * 剩余嫌疑集中在交互栈：ig.interact 每帧只更新"栈顶"条目，若商店开启瞬间栈顶被
 * 其他条目（消息 screenInteract、对话框、残留条目）压住，sc.menu.buttonInteract
 * 收不到鼠标点击，所有商店按钮静默失效。
 *
 * 本模块只做只读观测 + 日志（[mpdiag] 前缀），不改变任何行为：
 *  1. OPEN_SHOP 执行后：dump 交互栈、菜单 buttonInteract 激活态。
 *  2. ShopStartMenu.show 后：确认购买/出售按钮组是否真的被激活。
 *  3. ShopStartMenu.onButtonPress / setShopState / openShopQuantitySelect /
 *     buyItems：点击链路每一环是否到达。
 * 复现一次后把控制台日志发回即可定位断点在哪一环。
 */

type AnyRec = Record<string, any>;

function interactStackDump(): string {
	try {
		const igAny: AnyRec = (window as any).ig;
		const entries: any[] = (igAny && igAny.interact && igAny.interact.entries) || [];
		const names = entries.map((e: any) => {
			const ctor = e && e.constructor && e.constructor.name ? e.constructor.name : typeof e;
			const active = e && typeof e.isActive === 'function' ? (e.isActive() ? '+' : '-') : '?';
			return ctor + active;
		});
		const blocked = igAny && igAny.interact && typeof igAny.interact.isBlocked === 'function'
			? igAny.interact.isBlocked() : '?';
		return 'entries=[' + names.join(',') + '] blocked=' + blocked;
	} catch (e) {
		return 'dump failed: ' + e;
	}
}

function menuInteractDump(): string {
	try {
		const scAny: AnyRec = (window as any).sc;
		const bi: AnyRec = scAny && scAny.menu && scAny.menu.buttonInteract;
		if (!bi) return 'no buttonInteract';
		const active = typeof bi.isActive === 'function' ? bi.isActive() : '?';
		const stack = bi.buttonGroupStack ? bi.buttonGroupStack.length : -1;
		const parallel = bi.parallelGroups ? bi.parallelGroups.length : -1;
		const globals = bi.globalButtons ? bi.globalButtons.length : -1;
		return 'biActive=' + active + ' stack=' + stack + ' parallel=' + parallel + ' globals=' + globals;
	} catch (e) {
		return 'menu dump failed: ' + e;
	}
}

export function installShopDiag(): void {
	try {
		const w: AnyRec = window as any;
		if (w.__mpShopDiagInstalled) return;
		w.__mpShopDiagInstalled = true;
		const igAny: AnyRec = w.ig;
		const scAny: AnyRec = w.sc;
		if (!igAny || !scAny) return;

		// 1) OPEN_SHOP 事件步：商店打开瞬间的交互栈快照。
		try {
			const openShop: AnyRec = igAny.EVENT_STEP && igAny.EVENT_STEP.OPEN_SHOP;
			if (openShop && openShop.prototype && !openShop.prototype._mpDiagWrapped) {
				const origStart = openShop.prototype.start;
				openShop.prototype.start = function (this: AnyRec) {
					const r = origStart.apply(this, arguments as any);
					try {
						const sc2: AnyRec = (window as any).sc;
						console.log('[mpdiag] OPEN_SHOP id=' + (sc2.menu && sc2.menu.shopID)
							+ ' substate=' + (sc2.model && sc2.model.currentSubState)
							+ ' paused=' + !!((window as any).ig.game && (window as any).ig.game.paused)
							+ ' | ' + interactStackDump() + ' | ' + menuInteractDump());
					} catch (_) { /* ignore */ }
					return r;
				};
				openShop.prototype._mpDiagWrapped = true;
			}
		} catch (_) { /* ignore */ }

		// 2) ShopStartMenu.show：购买/出售按钮组激活确认 + 再次快照（菜单 GUI 此时已开）。
		try {
			const startMenu: AnyRec = scAny.ShopStartMenu;
			if (startMenu && startMenu.prototype && !startMenu.prototype._mpDiagWrapped) {
				const origShow = startMenu.prototype.show;
				startMenu.prototype.show = function (this: AnyRec) {
					const r = origShow.apply(this, arguments as any);
					try {
						const bg: AnyRec = this.buttongroup || this.buttonGroup;
						const grpActive = bg ? (bg._active !== undefined ? bg._active : (typeof bg.isActive === 'function' ? bg.isActive() : '?')) : 'no-group';
						console.log('[mpdiag] ShopStartMenu.show grpActive=' + grpActive
							+ ' | ' + interactStackDump() + ' | ' + menuInteractDump());
					} catch (_) { /* ignore */ }
					return r;
				};
				const origPress = startMenu.prototype.onButtonPress;
				if (origPress) {
					startMenu.prototype.onButtonPress = function (this: AnyRec, btn: any) {
						try {
							const sc2: AnyRec = (window as any).sc;
							console.log('[mpdiag] ShopStartMenu.onButtonPress '
								+ (btn === this.buy ? 'BUY' : btn === this.sell ? 'SELL' : 'other')
								+ ' shopState=' + (sc2.menu && sc2.menu.shopState));
						} catch (_) { /* ignore */ }
						return origPress.apply(this, arguments as any);
					};
				}
				startMenu.prototype._mpDiagWrapped = true;
			}
		} catch (_) { /* ignore */ }

		// 3) setShopState：状态切换是否发生（购买点击后应进入 BUY）。
		try {
			const menuModel: AnyRec = scAny.MenuModel;
			if (menuModel && menuModel.prototype && !menuModel.prototype._mpDiagShopStateWrapped) {
				const orig = menuModel.prototype.setShopState;
				menuModel.prototype.setShopState = function (this: AnyRec, state: any) {
					try { console.log('[mpdiag] setShopState ' + (this.shopState) + ' -> ' + state); } catch (_) { /* ignore */ }
					return orig.apply(this, arguments as any);
				};
				menuModel.prototype._mpDiagShopStateWrapped = true;
			}
		} catch (_) { /* ignore */ }

		// 4) 数量弹窗与结账链路。
		try {
			const menuModel: AnyRec = scAny.MenuModel;
			if (menuModel && menuModel.prototype && !menuModel.prototype._mpDiagQtyWrapped) {
				if (menuModel.prototype.openShopQuantitySelect) {
					const origQ = menuModel.prototype.openShopQuantitySelect;
					menuModel.prototype.openShopQuantitySelect = function (this: AnyRec) {
						try { console.log('[mpdiag] openShopQuantitySelect'); } catch (_) { /* ignore */ }
						return origQ.apply(this, arguments as any);
					};
				}
				menuModel.prototype._mpDiagQtyWrapped = true;
			}
			const shopScene: AnyRec = scAny.ShopMenuScene || scAny.ShopMenu;
			if (shopScene && shopScene.prototype && !shopScene.prototype._mpDiagBuyWrapped) {
				if (shopScene.prototype.buyItems) {
					const origB = shopScene.prototype.buyItems;
					shopScene.prototype.buyItems = function (this: AnyRec) {
						try { console.log('[mpdiag] buyItems EXECUTED'); } catch (_) { /* ignore */ }
						return origB.apply(this, arguments as any);
					};
				}
				shopScene.prototype._mpDiagBuyWrapped = true;
			}
		} catch (_) { /* ignore */ }

		// 5) 点击瞬间快照：菜单打开时鼠标按下的那一帧，dump 点击链路的全部门控值。
		// 若修复后仍有"点击无反应"，这一段日志能直接指出断在哪一道门（blocked /
		// mouseGuiActive / hover / 栈顶条目）。
		try {
			const bip: AnyRec = igAny.ButtonInteractEntry && igAny.ButtonInteractEntry.prototype;
			if (bip && !bip._mpDiagClickWrapped) {
				bip._mpDiagClickWrapped = true;
				const origUpd = bip.update;
				bip.update = function (this: AnyRec) {
					try {
						const sc2: AnyRec = (window as any).sc;
						const ig2: AnyRec = (window as any).ig;
						if (sc2 && sc2.model && sc2.model.isMenu && sc2.model.isMenu()
							&& sc2.control && sc2.control.getGuiClickPre && sc2.control.getGuiClickPre()) {
							const over: AnyRec = this.mouseOverGui;
							const overName = over
								? String((over.data !== undefined ? 'data=' + over.data + ' ' : '')
									+ (over.constructor && over.constructor.name || '?'))
								: 'null';
							console.log('[mpdiag] clickPre: blocked=' + ig2.interact.isBlocked()
								+ ' timer=' + (ig2.interact.blockTimer !== undefined ? Number(ig2.interact.blockTimer).toFixed(3) : '?')
								+ ' mouseGui=' + !!ig2.input.mouseGuiActive
								+ ' over=' + overName
								+ ' overActive=' + (over ? !!over.active : '-')
								+ ' | ' + interactStackDump() + ' | ' + menuInteractDump());
						}
					} catch (_) { /* ignore */ }
					return origUpd.apply(this, arguments as any);
				};
			}
		} catch (_) { /* ignore */ }

		console.log('[mpdiag] shop diagnostics installed');
	} catch (_) { /* ignore */ }
}
