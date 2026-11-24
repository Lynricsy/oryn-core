// Options page for Oryn / OMP Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_PORT = 9224;
const modeSelect = document.getElementById("mode");
const localSection = document.getElementById("local-section");
const orynSection = document.getElementById("oryn-section");
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const serverInput = document.getElementById("orynServerUrl");
const pairedInfo = document.getElementById("orynPairedInfo");
const unpairBtn = document.getElementById("unpair");
const status = document.getElementById("status");

function syncVisibility() {
	const isOryn = modeSelect.value === "oryn";
	localSection.style.display = isOryn ? "none" : "block";
	orynSection.style.display = isOryn ? "block" : "none";
}

modeSelect.addEventListener("change", syncVisibility);

chrome.storage.local
	.get({
		mode: "local",
		port: DEFAULT_PORT,
		token: "",
		orynServerUrl: "",
		orynDeviceToken: "",
		orynDeviceName: "",
	})
	.then(stored => {
		modeSelect.value = stored.mode === "oryn" ? "oryn" : "local";
		portInput.value = String(stored.port);
		tokenInput.value = String(stored.token);
		serverInput.value = String(stored.orynServerUrl || "");
		if (stored.orynDeviceToken) {
			pairedInfo.textContent = `Paired as: ${stored.orynDeviceName || "Chrome"}`;
			unpairBtn.style.display = "inline-block";
		} else {
			pairedInfo.textContent = "Not paired yet — click the toolbar extension icon to pair.";
			unpairBtn.style.display = "none";
		}
		syncVisibility();
	});

unpairBtn.addEventListener("click", async () => {
	await chrome.runtime.sendMessage({ t: "popup.unpair" });
	pairedInfo.textContent = "Unpaired.";
	unpairBtn.style.display = "none";
});

document.getElementById("save").addEventListener("click", async () => {
	const mode = modeSelect.value === "oryn" ? "oryn" : "local";
	if (mode === "local") {
		const port = Number(portInput.value);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			status.textContent = "invalid port";
			return;
		}
		await chrome.storage.local.set({ mode, port, token: tokenInput.value });
	} else {
		await chrome.storage.local.set({ mode, orynServerUrl: serverInput.value.trim() });
	}
	status.textContent = "saved";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
});
