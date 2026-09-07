const API_BASE = "http://localhost:8000/api";

// Manage Client Token (Persistent session)
let userToken = localStorage.getItem("aura_user_token");
if (!userToken) {
  userToken = "usr_" + Math.random().toString(36).substring(2, 12);
  localStorage.setItem("aura_user_token", userToken);
}

// State
let currentTier = "free";
let selectedBitrate = "192";
let currentUrl = "";

// DOM Elements
const extractForm = document.getElementById("extractForm");
const urlInput = document.getElementById("urlInput");
const pasteBtn = document.getElementById("pasteBtn");
const submitBtn = document.getElementById("submitBtn");
const btnText = submitBtn.querySelector(".btn-text");
const spinner = document.getElementById("spinner");
const statusMessage = document.getElementById("statusMessage");

const tierBadge = document.getElementById("tierBadge");
const openUpgradeBtn = document.getElementById("openUpgradeBtn");
const quotaText = document.getElementById("quotaText");

const bitrateChips = document.querySelectorAll(".bitrate-chip");
const resultCard = document.getElementById("resultCard");
const mediaThumbnail = document.getElementById("mediaThumbnail");
const mediaTitle = document.getElementById("mediaTitle");
const mediaDuration = document.getElementById("mediaDuration");
const mediaUploader = document.getElementById("mediaUploader");
const selectedQualityTag = document.getElementById("selectedQualityTag");
const downloadBtn = document.getElementById("downloadBtn");

// Modal Elements
const upgradeModal = document.getElementById("upgradeModal");
const closeModalBtn = document.getElementById("closeModalBtn");
const licenseKeyInput = document.getElementById("licenseKeyInput");
const activateLicenseBtn = document.getElementById("activateLicenseBtn");

// 1. Fetch User Status & Quota
async function syncUserStatus() {
  try {
    const res = await fetch(`${API_BASE}/user/status?token=${userToken}`);
    const data = await res.json();
    
    currentTier = data.tier;
    tierBadge.textContent = data.tier === "premium" ? "⚡ Pro Plan" : "Free Plan";
    tierBadge.className = `tier-pill ${data.tier === "premium" ? "tier-pro" : "tier-free"}`;

    if (data.tier === "premium") {
      openUpgradeBtn.classList.add("hidden");
      quotaText.textContent = `${data.remaining} of ${data.max_daily} Pro downloads left today`;
    } else {
      openUpgradeBtn.classList.remove("hidden");
      quotaText.textContent = `${data.remaining} / ${data.max_daily} Free downloads remaining today`;
    }
  } catch (err) {
    quotaText.textContent = "Offline / Server disconnected";
  }
}

// 2. Bitrate Selector Logic
bitrateChips.forEach(chip => {
  chip.addEventListener("click", () => {
    const bitrate = chip.dataset.bitrate;

    // Guard: Pro bitrates on Free Tier
    if ((bitrate === "256" || bitrate === "320") && currentTier === "free") {
      showModal();
      return;
    }

    bitrateChips.forEach(c => c.classList.remove("active"));
    chip.classList.add("active");
    selectedBitrate = bitrate;
    selectedQualityTag.textContent = `${selectedBitrate} kbps MP3`;
  });
});

// 3. Modal Handlers
function showModal() {
  upgradeModal.classList.remove("hidden");
}
function hideModal() {
  upgradeModal.classList.add("hidden");
}
openUpgradeBtn.addEventListener("click", showModal);
closeModalBtn.addEventListener("click", hideModal);

activateLicenseBtn.addEventListener("click", async () => {
  const key = licenseKeyInput.value.trim();
  if (!key) return;

  try {
    const res = await fetch(`${API_BASE}/user/upgrade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: userToken, license_key: key })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Activation failed.");

    hideModal();
    showStatus("⚡ Upgraded to Pro Plan! Enjoy 320 kbps and 50 downloads/day.", false);
    syncUserStatus();
  } catch (err) {
    alert(err.message);
  }
});

// 4. Paste Helper
pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) urlInput.value = text.trim();
  } catch (err) {
    showStatus("Clipboard access denied. Please paste manually.", true);
  }
});

function showStatus(msg, isError = false) {
  statusMessage.textContent = msg;
  statusMessage.className = `status-box ${isError ? 'error' : 'success'}`;
  statusMessage.classList.remove("hidden");
}
function hideStatus() {
  statusMessage.classList.add("hidden");
}

function formatDuration(seconds) {
  if (!seconds) return "00:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// 5. Submit & Metadata Retrieval
extractForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  hideStatus();
  resultCard.classList.add("hidden");
  submitBtn.disabled = true;
  btnText.textContent = "Analyzing Audio...";
  spinner.style.display = "block";
  currentUrl = url;

  try {
    const res = await fetch(`${API_BASE}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Unable to extract info.");

    mediaTitle.textContent = data.title || "Audio Track";
    mediaThumbnail.src = data.thumbnail || "https://images.unsplash.com/photo-1614680376593-902f749f7ffc?w=120&auto=format&fit=crop&q=60";
    mediaDuration.textContent = formatDuration(data.duration);
    mediaUploader.textContent = data.uploader || "Creator";
    selectedQualityTag.textContent = `${selectedBitrate} kbps MP3`;

    resultCard.classList.remove("hidden");
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
    btnText.textContent = "Analyze Link";
    spinner.style.display = "none";
  }
});

// 6. Audio Conversion & Download
downloadBtn.addEventListener("click", async () => {
  if (!currentUrl) return;

  downloadBtn.disabled = true;
  const originalText = downloadBtn.innerHTML;
  downloadBtn.innerHTML = `<span>Encoding ${selectedBitrate}k MP3...</span>`;

  try {
    const response = await fetch(`${API_BASE}/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: currentUrl,
        bitrate: selectedBitrate,
        token: userToken
      })
    });

    if (!response.ok) {
      const err = await response.json();
      if (response.status === 403 || response.status === 429) {
        showModal();
      }
      throw new Error(err.detail || "Download failed.");
    }

    const blob = await response.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `audio_${selectedBitrate}kbps.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);

    // Refresh quota count
    syncUserStatus();
  } catch (err) {
    showStatus(err.message, true);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = originalText;
  }
});

// Initialize on page load
syncUserStatus();
