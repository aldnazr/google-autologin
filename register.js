const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Aktifkan Stealth Plugin — bypass deteksi bot secara otomatis
// (webdriver, chrome.runtime, navigator.plugins, WebGL, canvas fingerprint, dll.)
puppeteer.use(StealthPlugin());
const fs = require("fs");
const path = require("path");

const CONFIG = {
  headless: false,
  timeout: 90000,
  accountFile: path.join(__dirname, "account.txt"),
  resultFile: path.join(__dirname, "result.txt"),
  delayBetweenAccounts: 2000,
  proxyServer: "", // Opsional: proxy IP (contoh: "http://127.0.0.1:8080")
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tunggu halaman benar-benar selesai di-load:
 * 1. document.readyState === 'complete'
 * 2. Tidak ada network request pending (networkidle)
 * 3. DOM stabil (tidak ada perubahan selama 500ms)
 */
async function waitForPageFullyLoaded(page, tag = "", timeout = 30000) {
  try {
    // Tunggu document.readyState === 'complete'
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout,
    });

    // Tunggu tidak ada network activity (networkidle0 = 0 koneksi selama 500ms)
    await page
      .waitForNetworkIdle({ idleTime: 500, timeout: Math.min(timeout, 15000) })
      .catch(() => null);

    // Tunggu DOM stabil (tidak ada mutasi selama 500ms)
    await page.evaluate(() => {
      return new Promise((resolve) => {
        let timer = null;
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        // Fallback: jika tidak ada mutasi dalam 1 detik, anggap stabil
        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, 1000);
      });
    });

    if (tag)
      console.log(
        `${tag}     ✓ Halaman fully loaded (${page.url().substring(0, 60)})`,
      );
  } catch (err) {
    if (tag)
      console.log(
        `${tag}     [WARN] waitForPageFullyLoaded timeout, melanjutkan... (${err.message})`,
      );
  }
}

/**
 * Bersihkan semua cache, cookies, localStorage, sessionStorage, IndexedDB
 * agar browser benar-benar bersih sebelum registrasi akun baru.
 */
async function clearBrowserData(page, tag = "") {
  try {
    const client = await page.createCDPSession();

    // Hapus semua cache browser
    await client.send("Network.clearBrowserCache");

    // Hapus semua cookies
    await client.send("Network.clearBrowserCookies");

    // Hapus localStorage, sessionStorage, IndexedDB, WebSQL, CacheStorage
    await client
      .send("Storage.clearDataForOrigin", {
        origin: "*",
        storageTypes: "all",
      })
      .catch(() => null);

    // Juga bersihkan via JS untuk memastikan
    await page
      .evaluate(() => {
        try {
          localStorage.clear();
        } catch (_) {}
        try {
          sessionStorage.clear();
        } catch (_) {}
      })
      .catch(() => null);

    await client.detach();

    if (tag)
      console.log(`${tag}     🧹 Cache, cookies, & storage dibersihkan.`);
  } catch (err) {
    if (tag)
      console.log(
        `${tag}     [WARN] Gagal membersihkan data browser: ${err.message}`,
      );
  }
}

function readAccounts() {
  if (!fs.existsSync(CONFIG.accountFile)) {
    console.error("Error: account.txt tidak ditemukan!");
    console.error(`Buat file: ${CONFIG.accountFile}`);
    console.error("Format: email|password (satu akun per baris)");
    process.exit(1);
  }

  const lines = fs.readFileSync(CONFIG.accountFile, "utf-8").split("\n");
  const accounts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;

    const parts = line.split("|");
    if (parts.length < 2) {
      console.error(`Baris ${i + 1}: format salah, gunakan email|password`);
      continue;
    }

    accounts.push({
      email: parts[0].trim(),
      password: parts[1].trim(),
    });
  }

  if (accounts.length === 0) {
    console.error("Error: tidak ada akun valid di account.txt");
    process.exit(1);
  }

  return accounts;
}

function appendResult(email, status) {
  const timestamp = new Date().toISOString();
  const line = `${timestamp} | ${email} | ${status}\n`;
  fs.appendFileSync(CONFIG.resultFile, line, "utf-8");
}

/**
 * Hapus akun yang sukses dari account.txt secara real-time
 */
function removeAccount(email) {
  try {
    if (!fs.existsSync(CONFIG.accountFile)) return;
    const content = fs.readFileSync(CONFIG.accountFile, "utf-8");
    const lines = content.split("\n");
    const updatedLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return true; // Pertahankan komentar / baris kosong
      const parts = trimmed.split("|");
      const accountEmail = parts[0].trim();
      return accountEmail.toLowerCase() !== email.toLowerCase();
    });
    fs.writeFileSync(CONFIG.accountFile, updatedLines.join("\n"), "utf-8");
    console.log(
      `     🗑️ Akun ${email} berhasil dihapus dari ${path.basename(CONFIG.accountFile)}`,
    );
  } catch (err) {
    console.error(
      `     [WARN] Gagal menghapus akun dari ${path.basename(CONFIG.accountFile)}: ${err.message}`,
    );
  }
}

async function waitAndType(page, selector, text, timeout = 15000) {
  await page.waitForSelector(selector, { visible: true, timeout });
  await sleep(400);
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, text, { delay: 40 });
}

async function clickByText(page, texts, tag = "*") {
  const textArray = Array.isArray(texts) ? texts : [texts];
  return await page.evaluate(
    ({ tag, textArray }) => {
      const elements = Array.from(document.querySelectorAll(tag));
      for (const text of textArray) {
        const lower = text.toLowerCase();
        for (const el of elements) {
          const t = (el.innerText || el.textContent || el.value || "")
            .trim()
            .toLowerCase();
          if (t === lower || (t.includes(lower) && t.length < 60)) {
            el.click();
            return true;
          }
        }
      }
      return false;
    },
    { tag, textArray },
  );
}

function waitForBrowserClosed(browser) {
  return new Promise((resolve) => {
    if (!browser || !browser.isConnected()) {
      return resolve();
    }
    const interval = setInterval(() => {
      if (!browser.isConnected()) {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
    browser.once("disconnected", () => {
      clearInterval(interval);
      resolve();
    });
  });
}

async function registerOne(browser, account, index, total) {
  const tag = `[${index}/${total}] ${account.email}`;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${tag} - Memulai proses login Google...`);
  console.log(`${"=".repeat(60)}\n`);

  // Gunakan halaman utama browser (hanya 1 jendela)
  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();
  page.setDefaultTimeout(CONFIG.timeout);

  // Step 0: Bersihkan cache & data browser sebelum mulai
  console.log(`${tag} [0] Membersihkan cache & data browser...`);
  await clearBrowserData(page, tag);

  let success = false;

  try {
    // Step 1: Buka halaman login Google langsung
    console.log(`${tag} [1] Membuka halaman login Google...`);
    await page.goto(
      "https://accounts.google.com/signin/v2/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin",
      {
        waitUntil: "networkidle2",
        timeout: 30000,
      },
    );
    await waitForPageFullyLoaded(page, tag);
    console.log(`${tag}     URL: ${page.url()}`);

    // Cek apakah sudah login (redirect ke myaccount)
    const alreadyLoggedIn =
      page.url().includes("myaccount.google.com") ||
      page.url().includes("accounts.google.com/Default");
    if (alreadyLoggedIn) {
      console.log(
        `${tag}     ✅ Sudah login ke Google! Skip input credentials.`,
      );
    } else {
      // Step 2: Input Email Google
      console.log(`${tag} [2] Input email Google...`);

      let emailField = null;
      const emailSelectors = [
        "#identifierId",
        'input[type="email"]',
        'input[name="identifier"]',
      ];
      for (let attempt = 0; attempt < 12 && !emailField; attempt++) {
        for (const sel of emailSelectors) {
          try {
            emailField = await page.waitForSelector(sel, {
              visible: true,
              timeout: 3000,
            });
            if (emailField) break;
          } catch (_) {}
        }
        if (!emailField && attempt < 11) {
          console.log(
            `${tag}     Mencari input email... (percobaan ${attempt + 1})`,
          );
          await sleep(2000);
        }
      }

      if (!emailField) {
        throw new Error(
          "Input email Google tidak ditemukan setelah 12 percobaan.",
        );
      }

      await emailField.click({ clickCount: 3 });
      await sleep(200);
      await emailField.type(account.email, { delay: 50 });
      await sleep(500);

      // Klik Next (email)
      console.log(`${tag}     Klik Next (email)...`);
      const nextEmailBtn = await page.$("#identifierNext");
      if (nextEmailBtn) {
        await Promise.all([
          page
            .waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 })
            .catch(() => null),
          nextEmailBtn.click(),
        ]);
      } else {
        await clickByText(
          page,
          ["Next", "Berikutnya", "Selanjutnya", "下一步"],
          "button",
        );
      }
      await waitForPageFullyLoaded(page, tag);

      // Deteksi error email
      const emailError = await page.evaluate(() => {
        const errEl = document.querySelector(
          '[class*="error"], [role="alert"], .o6cuMc',
        );
        return errEl ? errEl.innerText : null;
      });
      if (emailError) {
        console.log(`${tag}     [ERROR Google] ${emailError}`);
        throw new Error(`Google error pada email: ${emailError}`);
      }

      // Step 3: Input Password Google
      console.log(`${tag} [3] Input password Google...`);

      let passField = null;
      const passSelectors = [
        'input[type="password"][name="Passwd"]',
        'input[type="password"]',
        'input[name="password"]',
      ];
      for (let attempt = 0; attempt < 12 && !passField; attempt++) {
        for (const sel of passSelectors) {
          try {
            passField = await page.waitForSelector(sel, {
              visible: true,
              timeout: 3000,
            });
            if (passField) break;
          } catch (_) {}
        }
        if (!passField && attempt < 11) {
          console.log(
            `${tag}     Mencari input password... (percobaan ${attempt + 1})`,
          );
          await sleep(2000);

          // Cek 2FA
          const currentText = await page
            .evaluate(() => document.body.innerText)
            .catch(() => "");
          if (
            currentText.includes("2-Step Verification") ||
            currentText.includes("Verifikasi 2 Langkah")
          ) {
            console.log(
              `${tag}     [INFO] Terdeteksi 2FA. Silakan selesaikan manual di browser.`,
            );
            for (let w = 0; w < 30; w++) {
              const pf = await page.$('input[type="password"]');
              if (pf) {
                passField = pf;
                break;
              }
              if (!page.url().includes("accounts.google.com")) break;
              await sleep(2000);
            }
            break;
          }
        }
      }

      if (passField) {
        await passField.click({ clickCount: 3 });
        await sleep(200);
        await passField.type(account.password, { delay: 60 });
        await sleep(500);

        // Klik Next (password)
        console.log(`${tag}     Klik Next (password)...`);
        const nextPassBtn = await page.$("#passwordNext");
        if (nextPassBtn) {
          await Promise.all([
            page
              .waitForNavigation({ waitUntil: "networkidle0", timeout: 20000 })
              .catch(() => null),
            nextPassBtn.click(),
          ]);
        } else {
          await clickByText(
            page,
            ["Next", "Berikutnya", "Selanjutnya", "下一步"],
            "button",
          );
        }
        await waitForPageFullyLoaded(page, tag);

        // Deteksi error password salah
        const passError = await page.evaluate(() => {
          const errEl = document.querySelector(
            '[class*="error"], [role="alert"], .o6cuMc, .OyEIQ',
          );
          return errEl ? errEl.innerText : null;
        });
        if (
          passError &&
          (passError.includes("Wrong password") ||
            passError.includes("password") ||
            passError.includes("salah"))
        ) {
          console.log(`${tag}     [ERROR Google] ${passError}`);
          throw new Error(`Google error pada password: ${passError}`);
        }
      } else if (page.url().includes("accounts.google.com")) {
        throw new Error(
          "Input password Google tidak ditemukan setelah 12 percobaan.",
        );
      }
    }

    // Step 4: Verifikasi login Google berhasil
    console.log(`${tag} [4] Memverifikasi sesi login Google...`);

    for (let i = 0; i < 15; i++) {
      const currentUrl = page.url();
      if (
        currentUrl.includes("myaccount.google.com") ||
        currentUrl.includes("accounts.google.com/Default") ||
        currentUrl.includes("google.com/intl") ||
        !currentUrl.includes("signin")
      ) {
        break;
      }

      // Handle consent/agreement Google jika muncul
      await clickByText(
        page,
        [
          "I agree",
          "Saya setuju",
          "Continue",
          "Lanjutkan",
          "Accept",
          "Terima",
          "Not now",
          "Tidak sekarang",
        ],
        "button, div[role='button']",
      );

      await sleep(2000);
    }

    // Buka halaman myaccount untuk verifikasi login
    await page.goto("https://myaccount.google.com/", {
      waitUntil: "networkidle2",
      timeout: 20000,
    });
    await waitForPageFullyLoaded(page, tag);

    const googleLoggedIn =
      !page.url().includes("signin") && !page.url().includes("ServiceLogin");
    if (googleLoggedIn) {
      console.log(
        `\n${tag} ✅ Login Google BERHASIL! Sesi aktif untuk: ${account.email}`,
      );
      success = true;
      appendResult(account.email, "SUCCESS");
      removeAccount(account.email);
    } else {
      console.log(
        `\n${tag} [WARN] Login Google mungkin belum berhasil. URL: ${page.url()}`,
      );
      appendResult(account.email, "FAILED");
    }

    console.log(`${tag} 🌐 Browser tetap terbuka.`);
    console.log(
      `${tag} ⏳ Silakan lakukan aktivitas Anda. Tutup browser jika ingin lanjut ke akun berikutnya...\n`,
    );

    await waitForBrowserClosed(browser);
  } catch (err) {
    console.error(`${tag} ❌ Error: ${err.message}`);
    appendResult(account.email, "ERROR");
  } finally {
    console.log(`${tag} Selesai.`);
  }

  return success;
}

async function main() {
  const accounts = readAccounts();
  console.log(`\nTotal akun: ${accounts.length}`);
  console.log(`Results akan disimpan di: ${CONFIG.resultFile}\n`);

  // Buat file result dengan header jika belum ada
  if (!fs.existsSync(CONFIG.resultFile)) {
    fs.writeFileSync(
      CONFIG.resultFile,
      `Timestamp | Email | Status\n${"=".repeat(80)}\n`,
      "utf-8",
    );
  }

  console.log("Membuka browser Puppeteer (dengan Stealth Plugin)...");
  async function launchBrowser() {
    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      `--user-data-dir=${path.join(__dirname, ".chrome-profile")}`,
      "--window-size=1280,850",
    ];

    if (CONFIG.proxyServer) {
      launchArgs.push(`--proxy-server=${CONFIG.proxyServer}`);
      console.log(`Proxy server diterapkan: ${CONFIG.proxyServer}`);
    }

    return await puppeteer.launch({
      headless: CONFIG.headless,
      executablePath:
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: launchArgs,
      defaultViewport: { width: 960, height: 720 },
      ignoreDefaultArgs: ["--enable-automation"],
    });
  }

  let browser = await launchBrowser();

  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    // Jika browser mati/ditutup, buka instance baru
    if (!browser.isConnected()) {
      console.log(
        "\n[WARN] Browser terputus, membuka instance browser baru...",
      );
      await browser.close().catch(() => {});
      browser = await launchBrowser();
    }

    const success = await registerOne(
      browser,
      account,
      i + 1,
      accounts.length,
    );
    results.push({ email: account.email, success });

    if (i < accounts.length - 1) {
      console.log(
        `\nMenunggu ${CONFIG.delayBetweenAccounts / 1000} detik sebelum akun berikutnya...\n`,
      );
      await sleep(CONFIG.delayBetweenAccounts);
    }
  }

  if (browser.isConnected()) {
    await browser.close().catch(() => {});
  }

  // Ringkasan
  console.log(`\n${"=".repeat(60)}`);
  console.log("RINGKASAN HASIL");
  console.log(`${"=".repeat(60)}`);
  const successList = results.filter((r) => r.success);
  const failedList = results.filter((r) => !r.success);
  console.log(`Total  : ${results.length}`);
  console.log(`Sukses : ${successList.length}`);
  console.log(`Gagal  : ${failedList.length}`);

  if (successList.length > 0) {
    console.log(`\nAkun yang berhasil login Google:`);
    successList.forEach((r) => console.log(`  ${r.email}`));
  }

  if (failedList.length > 0) {
    console.log(`\nAkun yang belum berhasil:`);
    failedList.forEach((r) => console.log(`  ${r.email}`));
  }

  console.log(`\nDetail hasil tersimpan di: ${CONFIG.resultFile}`);
}

main();
