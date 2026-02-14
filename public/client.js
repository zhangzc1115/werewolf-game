const socket = io();

let me = null;
let isAdmin = false;
let joined = false;
let lastPhase = "";
let saveSlots = [];
let saveListRequested = false;

const STORAGE_TOKEN = "ww_player_token";
const STORAGE_NAME = "ww_player_name";
const STORAGE_ADMIN = "ww_is_admin";

const synth = window.speechSynthesis;

function speak(text) {
	if (!isAdmin) return;
	synth.cancel();
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.lang = "zh-CN";
	utterance.rate = 0.9;
	utterance.pitch = 1;
	synth.speak(utterance);
}

function showScreen(id) {
	document.querySelectorAll(".screen").forEach((el) => {
		el.classList.add("hidden");
	});
	const target = document.getElementById(id);
	if (target) target.classList.remove("hidden");
}

function setMaskText(text) {
	const title = document.querySelector("#mask h3");
	if (title) title.innerText = text;
}

function escapeHtml(str) {
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function appendAdminLog(message) {
	const log = document.getElementById("admin-log");
	if (!log) return;
	const row = document.createElement("div");
	row.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
	log.prepend(row);
}

function renderSaveSlots() {
	const select = document.getElementById("save-slot-select");
	if (!select) return;

	if (!saveSlots.length) {
		select.innerHTML = '<option value="">No saved games</option>';
		return;
	}

	select.innerHTML = saveSlots
		.map((slot) => {
			const summary = slot.summary || {};
			const elapsed = formatDuration(summary.elapsedMs || 0);
			const who = slot.savedBy || "Unknown";
			const notes = slot.notes ? ` | notes: ${slot.notes}` : "";
			const text = `${slot.label} | by ${who} | R${summary.round || 0} | ${summary.phase || "waiting"} | ${summary.alivePlayers || 0}/${summary.totalPlayers || 0} alive | t=${elapsed}${notes} | ${slot.savedAt || ""}`;
			return `<option value="${escapeHtml(slot.id)}">${escapeHtml(text)}</option>`;
		})
		.join("");
}

function formatDuration(ms) {
	const totalSec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}m${String(s).padStart(2, "0")}s`;
}

function refreshSaveList() {
	socket.emit("list-saves");
}

function saveCurrentGameSnapshot() {
	const labelInput = document.getElementById("save-label");
	const notesInput = document.getElementById("save-notes");
	const label = (labelInput?.value || "").trim();
	const notes = (notesInput?.value || "").trim();
	socket.emit("save-game", { label, notes });
	if (labelInput) labelInput.value = "";
	if (notesInput) notesInput.value = "";
}

function selectedSaveId() {
	const select = document.getElementById("save-slot-select");
	return String(select?.value || "").trim();
}

function loadSavedGameSnapshot() {
	const saveId = selectedSaveId();
	if (!saveId) {
		alert("Please select a saved game first.");
		return;
	}
	const confirmed = window.confirm(
		"Load this saved game? Current progress will be overwritten.",
	);
	if (!confirmed) return;
	socket.emit("load-game", { saveId });
}

function deleteSavedGameSnapshot() {
	const saveId = selectedSaveId();
	if (!saveId) {
		alert("Please select a saved game first.");
		return;
	}
	const confirmed = window.confirm(
		"Delete this saved game snapshot? This cannot be undone.",
	);
	if (!confirmed) return;
	socket.emit("delete-save", { saveId });
}

function roleName(role) {
	const map = {
		wolf: "狼人",
		wolf_king: "狼枪",
		witch: "女巫",
		seer: "预言家",
		hunter: "猎人",
		idiot: "白痴",
		hybrid: "混血儿",
		villager: "平民",
		spectator: "旁观",
		unassigned: "未分配",
	};
	return map[role] || "未知";
}

function winnerText(winner) {
	if (!winner) return "游戏结束";
	if (winner.team === "villagers") return `好人阵营胜利: ${winner.reason}`;
	if (winner.team === "wolves") return `狼人阵营胜利: ${winner.reason}`;
	return `平局: ${winner.reason || ""}`;
}

function announcePhase(phase) {
	switch (phase) {
		case "hybrid":
			speak("第一夜，混血儿请选择榜样。");
			break;
		case "wolf":
			speak("狼人请睁眼，选择击杀目标。");
			break;
		case "witch":
			speak("女巫请睁眼，决定是否用药。");
			break;
		case "seer":
			speak("预言家请睁眼，进行查验。");
			break;
		case "day_announce":
			speak("天亮了，请睁眼。");
			break;
		case "shoot_phase":
			speak("进入开枪阶段。");
			break;
		case "game_over":
			speak("游戏结束。");
			break;
		default:
			break;
	}
}

function getOrCreatePlayerToken() {
	let token = localStorage.getItem(STORAGE_TOKEN);
	if (!token) {
		token = self.crypto?.randomUUID
			? self.crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		localStorage.setItem(STORAGE_TOKEN, token);
	}
	return token;
}

function emitJoin(name) {
	const token = getOrCreatePlayerToken();
	localStorage.setItem(STORAGE_NAME, name);
	localStorage.setItem(STORAGE_ADMIN, "0");
	socket.emit("join", { name, token });
}

function renderPlayerList(state) {
	const list = document.getElementById("player-list");
	if (!list) return;

	const myId = state.me ? state.me.id : null;
	list.innerHTML = state.players
		.map((p) => {
			const meMark = p.id === myId ? " (我)" : "";
			const aliveMark = p.alive ? "" : " [出局]";
			const onlineMark = p.connected ? "" : " [离线]";
			const voteMark = p.canVote ? "" : " [无票]";
			const exposedMark = p.isExposed ? " [翻牌]" : "";
			const roleMark = p.role ? ` - ${roleName(p.role)}` : "";
			return `<div>${p.id}号 ${escapeHtml(p.name)}${meMark}${aliveMark}${onlineMark}${voteMark}${exposedMark}${roleMark}</div>`;
		})
		.join("");
}

function renderTargets(actionType, state, myId) {
	const grid = document.getElementById("targets");
	const extra = document.getElementById("extra-actions");
	const prompt = document.getElementById("action-prompt");
	if (!grid || !extra || !prompt) return;

	grid.innerHTML = "";
	extra.innerHTML = "";

	if (actionType === "wolf") prompt.innerText = "请选择击杀目标";
	if (actionType === "seer") prompt.innerText = "请选择查验目标";
	if (actionType === "hybrid_model")
		prompt.innerText = "第一夜：请选择你的榜样";
	if (actionType === "shoot") prompt.innerText = "请选择开枪目标";

	state.players.forEach((p) => {
		if (!p.alive || !p.connected || p.id === myId) return;
		const btn = document.createElement("button");
		btn.className = "target-btn";
		btn.innerText = `${p.id}号 ${p.name}`;
		btn.onclick = () => {
			if (actionType === "wolf")
				socket.emit("action", { type: "kill", targetId: p.id });
			if (actionType === "seer")
				socket.emit("action", { type: "check", targetId: p.id });
			if (actionType === "hybrid_model")
				socket.emit("action", { type: "hybrid_model", targetId: p.id });
			if (actionType === "shoot")
				socket.emit("action", { type: "shoot", targetId: p.id });
			btn.style.background = "#c0392b";
		};
		grid.appendChild(btn);
	});
}

function renderWitchActions(state, myId) {
	const grid = document.getElementById("targets");
	const extra = document.getElementById("extra-actions");
	const prompt = document.getElementById("action-prompt");
	if (!grid || !extra || !prompt) return;

	grid.innerHTML = "";
	extra.innerHTML = "";

	const witchPrompt = state.witchPrompt || {};
	prompt.innerText = witchPrompt.wolfTargetName
		? `今晚被刀的是：${witchPrompt.wolfTargetName}`
		: "今晚暂无狼人击杀结果";

	const saveBtn = document.createElement("button");
	saveBtn.innerText = witchPrompt.canSave ? "使用解药" : "解药已用";
	saveBtn.disabled = !witchPrompt.canSave;
	saveBtn.onclick = () => socket.emit("action", { type: "save" });
	extra.appendChild(saveBtn);

	const poisonBtn = document.createElement("button");
	poisonBtn.innerText = witchPrompt.canPoison ? "使用毒药" : "毒药已用";
	poisonBtn.disabled = !witchPrompt.canPoison;
	poisonBtn.onclick = () => {
		const target = Number(promptInput("输入毒杀玩家编号"));
		if (!Number.isInteger(target) || target === myId) return;
		socket.emit("action", { type: "poison", targetId: target });
	};
	extra.appendChild(poisonBtn);
}

function promptInput(text) {
	return window.prompt(text);
}

function renderDayVotePanel(state) {
	const panel = document.getElementById("day-vote-panel");
	if (!panel) return;

	if (state.gameMode !== "self_moderated") {
		panel.innerHTML = "";
		return;
	}

	const submitted = state.dayVote?.submittedCount || 0;
	const eligible = state.dayVote?.eligibleCount || 0;

	if (!me || !me.alive) {
		panel.innerHTML = `<div>白天投票中：${submitted}/${eligible}</div>`;
		return;
	}

	if (!me.canVote) {
		panel.innerHTML = `<div>白天投票中：${submitted}/${eligible}</div><div>你已失去投票权。</div>`;
		return;
	}

	const votedTarget = state.dayVote?.myVoteTargetId
		? state.players.find((p) => p.id === state.dayVote.myVoteTargetId)
		: null;

	const buttons = state.players
		.filter((p) => p.alive && p.id !== me.id)
		.map(
			(p) =>
				`<button class="target-btn" onclick="submitDayVote(${p.id})">${p.id}号 ${escapeHtml(p.name)}</button>`,
		)
		.join("");

	panel.innerHTML = `
        <div>白天投票中：${submitted}/${eligible}</div>
        <div>${votedTarget ? `你已投给：${escapeHtml(votedTarget.name)}` : "你尚未投票"}</div>
        <div class="grid">${buttons}</div>
    `;
}

function showGameOver(state) {
	const mask = document.getElementById("mask");
	const actionLayer = document.getElementById("action-layer");
	const dayLayer = document.getElementById("day-layer");
	const result = document.getElementById("day-result");

	if (mask) mask.classList.add("hidden");
	if (actionLayer) actionLayer.classList.add("hidden");
	if (dayLayer) dayLayer.classList.remove("hidden");
	if (result) result.innerText = winnerText(state.winner);
	renderDayVotePanel({ gameMode: "none" });
}

function handleGamePhase(phase, state) {
	const mask = document.getElementById("mask");
	const actionLayer = document.getElementById("action-layer");
	const dayLayer = document.getElementById("day-layer");
	if (!mask || !actionLayer || !dayLayer || !me) return;

	mask.classList.remove("hidden");
	actionLayer.classList.add("hidden");
	dayLayer.classList.add("hidden");

	if (phase === "game_over") {
		showGameOver(state);
		return;
	}

	if (phase === "shoot_phase") {
		const shooter = state.shootPhase || {};
		if (me.id === shooter.shooterId && !me.alive) {
			mask.classList.add("hidden");
			actionLayer.classList.remove("hidden");
			renderTargets("shoot", state, me.id);
		} else {
			setMaskText("开枪角色正在选择目标...");
		}
		return;
	}

	if (phase === "hybrid") {
		if (me.role === "hybrid" && me.alive && !me.modelId) {
			mask.classList.add("hidden");
			actionLayer.classList.remove("hidden");
			renderTargets("hybrid_model", state, me.id);
		} else {
			setMaskText("混血儿正在选择榜样...");
		}
		return;
	}

	if (!me.alive && phase !== "day_announce") {
		setMaskText("你已出局");
		return;
	}

	if (phase === "day_announce") {
		mask.classList.add("hidden");
		dayLayer.classList.remove("hidden");

		const deadIds = state.nightResult?.deadIds || [];
		const deadNames = deadIds
			.map((id) => state.players.find((p) => p.id === id))
			.filter(Boolean)
			.map((p) => p.name)
			.join("、");

		const notice = state.publicNotice ? `\n${state.publicNotice}` : "";
		const result = document.getElementById("day-result");
		if (result) {
			result.innerText =
				(deadNames ? `昨晚死亡：${deadNames}` : "昨晚平安夜") + notice;
		}
		renderDayVotePanel(state);
		return;
	}

	if (phase === "wolf" && (me.role === "wolf" || me.role === "wolf_king")) {
		mask.classList.add("hidden");
		actionLayer.classList.remove("hidden");
		renderTargets("wolf", state, me.id);
		return;
	}

	if (phase === "witch" && me.role === "witch") {
		mask.classList.add("hidden");
		actionLayer.classList.remove("hidden");
		renderWitchActions(state, me.id);
		return;
	}

	if (phase === "seer" && me.role === "seer") {
		mask.classList.add("hidden");
		actionLayer.classList.remove("hidden");
		renderTargets("seer", state, me.id);
		return;
	}

	if (me.role === "idiot" && me.isExposed) {
		setMaskText("你已翻牌（白痴），失去投票权但可继续发言。");
	} else if (me.role === "spectator") {
		setMaskText("你是旁观者。");
	} else {
		setMaskText("请等待当前回合结束。");
	}
}

function readRoleCount(id, fallbackValue) {
	const el = document.getElementById(id);
	if (!el) return fallbackValue;
	const v = Number(el.value);
	if (!Number.isInteger(v) || v < 0) return fallbackValue;
	return v;
}

function buildRoleConfig(prefix) {
	return {
		wolf: readRoleCount(`${prefix}-role-wolf`, 1),
		wolfKing: readRoleCount(`${prefix}-role-wolfKing`, 1),
		witch: readRoleCount(`${prefix}-role-witch`, 1),
		seer: readRoleCount(`${prefix}-role-seer`, 1),
		hunter: readRoleCount(`${prefix}-role-hunter`, 1),
		idiot: readRoleCount(`${prefix}-role-idiot`, 1),
		hybrid: readRoleCount(`${prefix}-role-hybrid`, 1),
	};
}

function joinGame() {
	const name = (document.getElementById("username")?.value || "").trim();
	if (!name) {
		alert("请输入名字");
		return;
	}

	isAdmin = false;
	joined = true;
	emitJoin(name);
	showScreen("lobby");
}

function initAdmin() {
	isAdmin = true;
	joined = true;
	saveListRequested = false;
	localStorage.setItem(STORAGE_ADMIN, "1");
	socket.emit("admin-claim");
	showScreen("admin");
}

function startGame() {
	const winCondition = document.getElementById("admin-win-condition")?.value;
	socket.emit("admin-start", {
		rolesConfig: buildRoleConfig("admin"),
		winCondition,
	});
}

function startSelfModeratedGame() {
	const winCondition = document.getElementById("lobby-win-condition")?.value;
	socket.emit("player-start-self", {
		rolesConfig: buildRoleConfig("lobby"),
		winCondition,
	});
}

function releaseAdmin() {
	socket.emit("admin-release");
	localStorage.setItem(STORAGE_ADMIN, "0");
	isAdmin = false;
	showScreen("lobby");
}

function transferAdmin() {
	const el = document.getElementById("transfer-player-id");
	const targetPlayerId = Number(el?.value);
	if (!Number.isInteger(targetPlayerId) || targetPlayerId <= 0) {
		alert("请输入有效玩家ID");
		return;
	}
	socket.emit("admin-transfer", { targetPlayerId });
}

function nextPhase(phase) {
	socket.emit("admin-next-phase", phase);
}

function dayVoteOut() {
	const target = Number(window.prompt("输入白天票出玩家编号"));
	if (!Number.isInteger(target)) {
		alert("编号无效");
		return;
	}
	socket.emit("admin-day-vote", { targetId: target });
}

function submitDayVote(targetId) {
	socket.emit("action", { type: "day_vote", targetId });
}

function hardResetGame() {
	const confirmed = window.confirm(
		"Hard reset will clear the current game for everyone and remove saved local identity/admin state. Continue?",
	);
	if (!confirmed) return;
	socket.emit("hard-reset");
}

socket.on("connect", () => {
	const adminFlag = localStorage.getItem(STORAGE_ADMIN) === "1";

	if (adminFlag) {
		isAdmin = true;
		joined = true;
		saveListRequested = false;
		socket.emit("admin-claim");
		showScreen("admin");
		return;
	}

	const savedName = localStorage.getItem(STORAGE_NAME);
	const savedToken = localStorage.getItem(STORAGE_TOKEN);
	if (savedName && savedToken) {
		isAdmin = false;
		joined = true;
		socket.emit("join", { name: savedName, token: savedToken });
		showScreen("lobby");
	}
});

socket.on("join-ack", (payload) => {
	if (payload?.token) localStorage.setItem(STORAGE_TOKEN, payload.token);
	if (payload?.name) localStorage.setItem(STORAGE_NAME, payload.name);
});

socket.on("update", (state) => {
	me = state.me;
	renderPlayerList(state);

	if (!joined) return;

	if (state.phase === "waiting") {
		showScreen(isAdmin ? "admin" : "lobby");
		const waiting = document.getElementById("waiting-msg");
		if (waiting && state.gameMode === "self_moderated") {
			waiting.innerText = "等待玩家点击自主持开始";
		}
		return;
	}

	if (isAdmin) {
		showScreen("admin");
		if (!saveListRequested) {
			socket.emit("list-saves");
			saveListRequested = true;
		}
		if (lastPhase !== state.phase) {
			announcePhase(state.phase);
			lastPhase = state.phase;
		}
		return;
	}

	showScreen("game");
	const myRole = document.getElementById("my-role-display");
	if (myRole) {
		const exposed = me?.role === "idiot" && me?.isExposed ? "（已翻牌）" : "";
		const winText = state.winCondition === "side-kill" ? "屠边" : "屠城";
		myRole.innerText = me
			? `我的身份: ${roleName(me.role)} ${exposed} | 胜利条件: ${winText}`.trim()
			: "我的身份: 未知";
	}

	if (state.publicNotice && state.phase !== "day_announce") {
		setMaskText(state.publicNotice);
	}

	handleGamePhase(state.phase, state);
});

socket.on("admin-log", (message) => {
	if (isAdmin) appendAdminLog(message);
});

socket.on("seer-result", (res) => {
	alert(`查验结果：${res.name} 是 ${res.isGood ? "好人" : "狼人"}`);
});

socket.on("start-error", (payload) => {
	if (payload?.message) alert(payload.message);
});

socket.on("transfer-error", (payload) => {
	if (payload?.message) alert(payload.message);
});

socket.on("admin-granted", () => {
	isAdmin = true;
	joined = true;
	saveListRequested = false;
	localStorage.setItem(STORAGE_ADMIN, "1");
	showScreen("admin");
	socket.emit("list-saves");
	saveListRequested = true;
});

socket.on("admin-revoked", () => {
	isAdmin = false;
	saveListRequested = false;
	saveSlots = [];
	renderSaveSlots();
	localStorage.setItem(STORAGE_ADMIN, "0");
	if (joined) showScreen("lobby");
});

socket.on("save-list", (list) => {
	saveSlots = Array.isArray(list) ? list : [];
	renderSaveSlots();
});

socket.on("hard-reset", (payload) => {
	isAdmin = false;
	joined = false;
	me = null;
	lastPhase = "";
	saveListRequested = false;
	saveSlots = [];
	renderSaveSlots();
	localStorage.removeItem(STORAGE_ADMIN);
	localStorage.removeItem(STORAGE_NAME);
	localStorage.removeItem(STORAGE_TOKEN);
	showScreen("login");
	if (payload?.message) {
		alert(payload.message);
	}
});

window.joinGame = joinGame;
window.initAdmin = initAdmin;
window.startGame = startGame;
window.startSelfModeratedGame = startSelfModeratedGame;
window.nextPhase = nextPhase;
window.dayVoteOut = dayVoteOut;
window.submitDayVote = submitDayVote;
window.releaseAdmin = releaseAdmin;
window.transferAdmin = transferAdmin;
window.hardResetGame = hardResetGame;
window.refreshSaveList = refreshSaveList;
window.saveCurrentGameSnapshot = saveCurrentGameSnapshot;
window.loadSavedGameSnapshot = loadSavedGameSnapshot;
window.deleteSavedGameSnapshot = deleteSavedGameSnapshot;
