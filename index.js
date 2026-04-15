import 'dotenv/config';

import { createReadStream, existsSync } from 'fs';
import { unlink, stat, readdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { execFile, execSync } from 'child_process';
import { promisify } from 'util';
import { Bot, InputFile, InlineKeyboard, webhookCallback } from 'grammy';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import translations from './translations.js';
import { isYouTubeUrl, isYouTubePlaylist, extractVideoId } from './utils.js';

const execFileAsync = promisify(execFile);

const YTDLP_PATH = (() => {
  try { return execSync('which yt-dlp').toString().trim(); } catch { return 'yt-dlp'; }
})();
console.log('yt-dlp path:', YTDLP_PATH);

const FFMPEG_PATH = (() => {
  try { return execSync('which ffmpeg').toString().trim(); } catch { return 'ffmpeg'; }
})();
console.log('ffmpeg path:', FFMPEG_PATH);

const {
  TELEGRAM_TOKEN,
  TELEGRAM_WEBHOOK_URL,
  TELEGRAM_API_URL,
  BOT_USERNAME,
} = process.env;

const MAX_VIDEO_DURATION_SEC = process.env.MAX_VIDEO_DURATION_MIN
  ? Number(process.env.MAX_VIDEO_DURATION_MIN) * 60
  : null;

const WALLETS = {
  BTC:        '1KgxUoCK87hPrLVDXYwpQzZqS6Mus7D6N8',
  ETH:        '0xb0db7cb3c18a02c969416d4ec06bdd703d1756f8',
  TON:        'UQBuvR1J5N6XOlA2tuQ0xMT1OgAp6XG0BAEuap3zNHhrb6ba',
  USDT_TRC20: 'TQze9DixKds37maVgmnuVENnUDT7UynaRy',
};

const DONATE_CARD = '5188 9402 9700 6058 (Daria Mafteuta)';
const DONATE_PEREVODILKA = '077974315 (Дарья М.)';

const COOKIES_FILE = process.env.COOKIES_FILE ?? 'cookies.txt';

function buildYtdlpArgs(extraArgs = []) {
  const args = ['--no-check-certificates', '--js-runtimes', `node:${process.execPath}`, '--remote-components', 'ejs:github'];
  if (FFMPEG_PATH && FFMPEG_PATH !== 'ffmpeg') {
    args.push('--ffmpeg-location', FFMPEG_PATH);
  }
  if (existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }
  return [...args, ...extraArgs];
}

async function getVideoInfo(url) {
  const args = buildYtdlpArgs(['--dump-json', '--no-playlist', url]);
  const { stdout } = await execFileAsync(YTDLP_PATH, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

async function getPlaylistInfo(playlistUrl) {
  const args = buildYtdlpArgs([
    '--flat-playlist',
    '--dump-single-json',
    '--no-warnings',
    playlistUrl,
  ]);
  const { stdout } = await execFileAsync(YTDLP_PATH, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

function getQualityLabels(info) {
  const heights = [...new Set(
    (info.formats ?? [])
      .filter((f) => f.vcodec && f.vcodec !== 'none' && f.height)
      .map((f) => f.height)
  )];
  return heights
    .filter((h) => h >= 360)
    .sort((a, b) => a - b)
    .map((h) => `${h}p`);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDuration(seconds) {
  seconds = Math.floor(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function hasAudioTrack(info) {
  return (info.formats ?? []).some(
    (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
  );
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB — Telegram local Bot API limit

function estimateVideoSize(info, qualityLabel) {
  const height = qualityLabel === 'best' ? Infinity : parseInt(qualityLabel);
  const formats = info.formats ?? [];
  const videoFormat = formats
    .filter(f => f.vcodec && f.vcodec !== 'none' && f.height && f.height <= height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  const audioFormat = formats
    .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))[0];
  const videoSize = videoFormat?.filesize ?? videoFormat?.filesize_approx ?? null;
  const audioSize = audioFormat?.filesize ?? audioFormat?.filesize_approx ?? null;
  if (videoSize === null && audioSize === null) return null;
  return (videoSize ?? 0) + (audioSize ?? 0);
}

function getBestThumbnailUrl(info) {
  return info.thumbnail ?? null;
}

async function cleanupTmpPrefix(dir, basename) {
  try {
    const files = await readdir(dir);
    await Promise.all(
      files.filter(f => f.startsWith(basename)).map(f => unlink(join(dir, f)).catch(() => {}))
    );
  } catch {}
}

async function downloadVideoAudio(url, qualityLabel) {
  const height = parseInt(qualityLabel);
  const dir = tmpdir();
  const basename = randomBytes(8).toString('hex');
  const prefix = join(dir, basename);
  const outputPath = `${prefix}.mp4`;

  const formatSelector = height
    ? [
        `bestvideo[height<=${height}][vcodec^=avc][ext=mp4]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${height}][vcodec^=avc]+bestaudio[ext=m4a]`,
        `bestvideo[height<=${height}][vcodec^=avc]+bestaudio`,
        `bestvideo[height<=${height}]+bestaudio`,
        `best[height<=${height}]`,
        'best',
      ].join('/')
    : 'best';

  const args = buildYtdlpArgs([
    '-f', formatSelector,
    '--merge-output-format', 'mp4',
    '--embed-metadata',
    '--concurrent-fragments', '4',
    '-o', outputPath,
    '--no-playlist',
    url,
  ]);

  try {
    await execFileAsync(YTDLP_PATH, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    await cleanupTmpPrefix(dir, basename);
    throw err;
  }
  return outputPath;
}

async function downloadAudioOnly(url) {
  const dir = tmpdir();
  const basename = randomBytes(8).toString('hex');
  const prefix = join(dir, basename);

  const args = buildYtdlpArgs([
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '-x',
    '--audio-format', 'mp3',
    '--embed-metadata',
    '-o', `${prefix}.%(ext)s`,
    '--print', 'after_move:%(abr)s',
    '--print', 'after_move:filepath',
    '--no-playlist',
    url,
  ]);

  let stdout;
  try {
    ({ stdout } = await execFileAsync(YTDLP_PATH, args, { timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 }));
  } catch (err) {
    await cleanupTmpPrefix(dir, basename);
    throw err;
  }
  const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const outputPath = lines.at(-1) || `${prefix}.mp3`;
  const abr = parseFloat(lines.at(-2)) || null;
  return { outputPath, abr };
}

const pendingMap = new Map(); // Map<userId, { videos: { url, title }[], thumbnailUrl, qualityLabels, audioAvailable, duration }>
const downloadCountMap = new Map(); // Map<userId, number>
const awaitingStarsMap = new Map(); // Map<userId, true>

function getLang(ctx) {
  return ctx.from?.language_code === 'ru' ? 'ru' : 'en';
}

function buildCryptoText(lang) {
  const t = translations[lang].donate;
  return [
    `<b>${t.crypto_label}</b>`,
    '',
    `ꘜ TON (TON):\n<code>${WALLETS.TON}</code>`,
    '',
    `₮ USDT (TRC20):\n<code>${WALLETS.USDT_TRC20}</code>`,
    '',
    `₿ BTC (BTC):\n<code>${WALLETS.BTC}</code>`,
    '',
    `⟠ ETH (ERC20):\n<code>${WALLETS.ETH}</code>`,
    '',
    `<i>${t.copied}</i>`,
  ].join('\n');
}

function buildPaymentsText(lang) {
  const t = translations[lang].donate;
  const lines = [`<b>${t.payments_label}</b>`, ''];
  if (DONATE_CARD) lines.push(`💳 Visa/Mastercard:\n<code>${DONATE_CARD}</code>`);
  if (DONATE_CARD && DONATE_PEREVODILKA) lines.push('');
  if (DONATE_PEREVODILKA) lines.push(`💸 Perevodilka PMR:\n<code>${DONATE_PEREVODILKA}</code>`);
  lines.push('', `<i>${t.copied}</i>`);
  return lines.join('\n');
}

function buildSupportText(lang) {
  const t = translations[lang].support;
  return [
    `👨‍💻 <b>${t.label}</b>`,
    '',
    `📧 ${t.email}: <code>badican01117@gmail.com</code>`,
    `💬 ${t.telegram}: <a href="https://t.me/ibadichan">t.me/ibadichan</a>`,
  ].join('\n');
}

function buildDonateKeyboard(lang) {
  const k = translations[lang].donate.keyboard;
  return new InlineKeyboard()
    .text(k.stars, 'donate:stars')
    .text(k.crypto, 'donate:crypto')
    .text(k.payments, 'donate:payments')
    .row()
    .text(k.other, 'donate:other');
}

const bot = new Bot(TELEGRAM_TOKEN, {
  client: { apiRoot: TELEGRAM_API_URL },
});

bot.catch((err) => console.error('Unhandled bot error:', err));

async function processMedia(ctx, quality, type = 'video+audio', sourceMsg = null) {
  const userId = ctx.from.id;
  const lang = getLang(ctx);
  const entry = pendingMap.get(userId);

  if (!entry) {
    await ctx.reply(translations[lang].errors.session_expired);
    return;
  }

  const { videos: videoList, thumbnailUrl, duration, sizeByQuality } = entry;

  if (type !== 'audio' && sizeByQuality) {
    const estimatedSize = sizeByQuality[quality ?? 'best'] ?? null;
    if (estimatedSize !== null && estimatedSize > MAX_FILE_BYTES) {
      await ctx.reply(`${translations[lang].errors.file_too_large} (~${formatFileSize(estimatedSize)})`);
      return;
    }
  }

  if (type !== 'audio' && MAX_VIDEO_DURATION_SEC && duration && duration > MAX_VIDEO_DURATION_SEC) {
    const maxMin = Math.round(MAX_VIDEO_DURATION_SEC / 60);
    const durationMin = Math.ceil(duration / 60);
    await ctx.reply(`${translations[lang].errors.video_too_long} ${maxMin} min (video: ${durationMin} min)`);
    return;
  }

  const size = videoList.length;
  let errorSize = 0;
  let infoMsg = null;

  if (sourceMsg) {
    try {
      await ctx.api.deleteMessage(sourceMsg.chat.id, sourceMsg.message_id);
    } catch (e) {
      console.error('Failed to delete source message:', e);
    }

    const loadingCaption = `⏳ ${translations[lang].status.downloading}`;
    try {
      if (thumbnailUrl) {
        infoMsg = await ctx.replyWithPhoto(thumbnailUrl, { caption: loadingCaption });
      } else {
        infoMsg = await ctx.reply(loadingCaption);
      }
    } catch (e) {
      console.error('Failed to send loading message:', e);
    }
  }

  while (videoList.length > 0) {
    const { url, title, uploader } = videoList.at(-1);
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
    let outputPath = null;

    try {
      if (type === 'audio') {
        const { outputPath: audioPath, abr } = await downloadAudioOnly(url);
        outputPath = audioPath;
        const { size: audioBytes } = await stat(outputPath);
        const ta = translations[lang].audio;
        const audioCaptionLines = [`🎵 <b>${escapeHtml(title)}</b>`];
        const metaParts = [];
        if (abr) metaParts.push(`🎧 <b>${ta.bitrate}:</b> ${Math.round(abr)} kbps`);
        metaParts.push(`<b>${ta.size}:</b> ${formatFileSize(audioBytes)}`);
        audioCaptionLines.push(metaParts.join(' | '));
        audioCaptionLines.push(`🔗 <a href="${url}"><b>${ta.source}</b></a>`);
        audioCaptionLines.push('');
        if (BOT_USERNAME) audioCaptionLines.push(`@${BOT_USERNAME}`);
        await ctx.replyWithAudio(
          new InputFile(createReadStream(outputPath), `${safeTitle}.mp3`),
          { title, performer: uploader ?? undefined, caption: audioCaptionLines.join('\n'), parse_mode: 'HTML' }
        );
      } else {
        outputPath = await downloadVideoAudio(url, quality);
        const { size: fileBytes } = await stat(outputPath);
        const t = translations[lang].video;
        const captionLines = [`🎬 <b>${escapeHtml(title)}</b>`];
        if (uploader) captionLines.push(`👤 <b>${t.author}:</b> ${escapeHtml(uploader)}`);
        if (duration) captionLines.push(`⏱ <b>${t.duration}:</b> ${formatDuration(duration)}`);
        if (quality) captionLines.push(`⚙️ <b>${t.resolution}:</b> ${quality} | <b>${t.size}:</b> ${formatFileSize(fileBytes)}`);
        captionLines.push(`🔗 <a href="${url}"><b>${t.source}</b></a>`);
        captionLines.push('');
        if (BOT_USERNAME) captionLines.push(`@${BOT_USERNAME}`);
        await ctx.replyWithDocument(
          new InputFile(createReadStream(outputPath), `${safeTitle}.mp4`),
          { caption: captionLines.join('\n'), parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      errorSize += 1;
      console.error(error);
      const stderr = (error.stderr ?? '').trim();
      const brief = (stderr || (error.message ?? '')).split('\n').filter(l => l.trim()).at(-1)?.slice(0, 200) ?? '';
      const msg = error.error_code === 413
        ? translations[lang].errors.file_too_large
        : `${translations[lang].status.error} (${brief})`;
      await ctx.reply(msg);
    } finally {
      if (outputPath) await unlink(outputPath).catch(() => {});
    }

    videoList.pop();
  }

  if (infoMsg) {
    try {
      await ctx.api.deleteMessage(infoMsg.chat.id, infoMsg.message_id);
    } catch (e) {
      console.error('Failed to delete loading message:', e);
    }
  }

  console.log(`[user:${userId}] done: ${size - errorSize}/${size} ok`);

  const prevCount = downloadCountMap.get(userId) ?? 0;
  const newCount = prevCount + (size - errorSize);
  downloadCountMap.set(userId, newCount);

  if (Math.floor(newCount / 5) > Math.floor(prevCount / 5)) {
    await ctx.reply(translations[lang].donate.appeal, { reply_markup: buildDonateKeyboard(lang) });
  }
}

const MAIN_RESOLUTIONS = [360, 480, 720, 1080];

function buildQualityKeyboard(lang, qualityLabels, audioAvailable, showAll = false) {
  const keyboard = new InlineKeyboard();
  const mainLabels = MAIN_RESOLUTIONS
    .map((res) => qualityLabels.find((l) => parseInt(l) === res))
    .filter(Boolean);
  const mainSet = new Set(mainLabels);
  const extraLabels = qualityLabels.filter((l) => !mainSet.has(l));
  const toShow = (showAll || mainLabels.length === 0) ? qualityLabels : mainLabels;

  if (toShow.length === 0) {
    // No quality info available (e.g. some platforms) — offer a single download button
    keyboard.text(`🎬 ${translations[lang].quality_select.options.best}`, 'dl:best');
  } else {
    toShow.forEach((label, i) => {
      if (i > 0 && i % 4 === 0) keyboard.row();
      keyboard.text(`🎬 ${label}`, `dl:${label}`);
    });

    if (!showAll && mainLabels.length > 0 && extraLabels.length > 0) {
      keyboard.row().text(translations[lang].quality_select.options.other, 'dl:more');
    }
  }

  if (audioAvailable) {
    keyboard.row().text(translations[lang].quality_select.options.audio, 'dl:audio');
  }

  return keyboard;
}

bot.callbackQuery(/^dl:/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const lang = getLang(ctx);
  const value = ctx.callbackQuery.data.slice(3);

  if (value === 'more') {
    const entry = pendingMap.get(ctx.from.id);
    if (!entry) return;
    const keyboard = buildQualityKeyboard(lang, entry.qualityLabels, entry.audioAvailable, true);
    await ctx.editMessageReplyMarkup({ reply_markup: keyboard }).catch((e) => {
      if (e.error_code !== 400) throw e;
    });
    return;
  }

  const sourceMsg = ctx.callbackQuery.message;
  if (value === 'audio') {
    processMedia(ctx, 'best', 'audio', sourceMsg).catch(console.error);
  } else {
    processMedia(ctx, value === 'best' ? null : value, 'video+audio', sourceMsg).catch(console.error);
  }
});

bot.command('start', async (ctx) => {
  const lang = getLang(ctx);
  pendingMap.delete(ctx.from.id);
  const username = BOT_USERNAME ? ` @${BOT_USERNAME}` : '';
  await ctx.reply(translations[lang].greeting(username) + '\n\n' + translations[lang].getting_started);
  await ctx.reply(translations[lang].donate.appeal, { reply_markup: buildDonateKeyboard(lang) });
});

bot.command('donate', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.reply(translations[lang].donate.appeal, { reply_markup: buildDonateKeyboard(lang) });
});

bot.command('support', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.reply(buildSupportText(lang), { parse_mode: 'HTML' });
});

bot.command('help', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.reply(translations[lang].help.text, { parse_mode: 'HTML' });
});

bot.callbackQuery('donate:crypto', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.answerCallbackQuery();
  await ctx.reply(buildCryptoText(lang), { parse_mode: 'HTML' });
});

bot.callbackQuery('donate:payments', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.answerCallbackQuery();
  await ctx.reply(buildPaymentsText(lang), { parse_mode: 'HTML' });
});

bot.callbackQuery('donate:other', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.answerCallbackQuery();
  await ctx.reply(buildSupportText(lang), { parse_mode: 'HTML' });
});

const STARS_AMOUNTS = [1, 5, 10, 50, 100, 500];

bot.callbackQuery('donate:stars', async (ctx) => {
  const lang = getLang(ctx);
  const t = translations[lang].donate;
  await ctx.answerCallbackQuery();
  const links = await Promise.all(
    STARS_AMOUNTS.map((n) =>
      ctx.api.createInvoiceLink(
        t.stars_title,
        t.stars_description,
        `donation_${n}`,
        '',
        'XTR',
        [{ label: t.stars_title, amount: n }]
      )
    )
  );
  const keyboard = new InlineKeyboard();
  STARS_AMOUNTS.forEach((n, i) => {
    if (i > 0 && i % 3 === 0) keyboard.row();
    keyboard.url(`⭐ ${n}`, links[i]);
  });
  keyboard.row().text(t.keyboard.stars_custom, 'stars:custom');
  await ctx.reply(t.stars_description, { reply_markup: keyboard });
});

bot.callbackQuery('stars:custom', async (ctx) => {
  const lang = getLang(ctx);
  await ctx.answerCallbackQuery();
  awaitingStarsMap.set(ctx.from.id, true);
  await ctx.reply(translations[lang].donate.stars_enter_amount);
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('message:successful_payment', async (ctx) => {
  const lang = getLang(ctx);
  const stars = ctx.message.successful_payment.total_amount;
  console.log(`[stars] payment from user:${ctx.from.id} amount:${stars}`);
  await ctx.reply(translations[lang].donate.stars_thanks);
});

bot.on('message', async (ctx) => {
  const userId = ctx.from.id;
  const url = ctx.message.text?.trim();
  const lang = getLang(ctx);

  console.log(`[user:${userId}] message: ${url}`);

  if (awaitingStarsMap.get(userId)) {
    const t = translations[lang].donate;
    const amount = parseInt(url);
    if (!amount || amount < 1 || amount > 10000) {
      await ctx.reply(t.stars_invalid_amount);
      return;
    }
    awaitingStarsMap.delete(userId);
    const link = await ctx.api.createInvoiceLink(
      t.stars_title,
      t.stars_description,
      `donation_${amount}`,
      '',
      'XTR',
      [{ label: t.stars_title, amount }]
    );
    const keyboard = new InlineKeyboard().url(`⭐ ${amount}`, link);
    await ctx.reply(t.stars_description, { reply_markup: keyboard });
    return;
  }

  if (!url) {
    await ctx.reply(translations[lang].errors.no_url);
    return;
  }

  try {
    new URL(url); // validate URL syntax
  } catch {
    await ctx.reply(translations[lang].errors.invalid_url);
    return;
  }

  const searchingMsg = await ctx.reply(translations[lang].status.searching).catch(() => null);
  const deleteSearchingMsg = () => searchingMsg && ctx.api.deleteMessage(searchingMsg.chat.id, searchingMsg.message_id).catch(() => {});

  try {
    let videos = [];
    let qualityLabels = [];
    let audioAvailable = false;
    let thumbnailUrl = null;
    let caption = null;
    let duration = null;
    let sizeByQuality = null;

    if (isYouTubePlaylist(url)) {
      const playlist = await getPlaylistInfo(url);

      for (const entry of (playlist.entries ?? [])) {
        if (entry.id) {
          videos.push({
            url: `https://www.youtube.com/watch?v=${entry.id}`,
            title: entry.title ?? entry.id,
          });
        }
      }

      if (videos.length > 0) {
        const info = await getVideoInfo(videos[0].url);
        qualityLabels = getQualityLabels(info);
        audioAvailable = hasAudioTrack(info);
        thumbnailUrl = getBestThumbnailUrl(info);
      }

      caption = `📋 <b>${escapeHtml(playlist.title ?? 'Playlist')}</b>`;
    } else {
      const info = await getVideoInfo(url);
      const title = info.title ?? url;
      duration = info.duration ?? null;
      qualityLabels = getQualityLabels(info);
      audioAvailable = hasAudioTrack(info);
      thumbnailUrl = getBestThumbnailUrl(info);
      sizeByQuality = Object.fromEntries(
        [...qualityLabels, 'best'].map(q => [q, estimateVideoSize(info, q)])
      );
      // Normalise YouTube URLs to canonical form; keep other URLs as-is
      const canonicalUrl = isYouTubeUrl(url)
        ? `https://www.youtube.com/watch?v=${extractVideoId(url)}`
        : url;
      videos.push({ url: canonicalUrl, title, uploader: info.uploader ?? info.channel ?? null });
      caption = `<b>${escapeHtml(title)}</b>`;
    }

    if (videos.length === 0) {
      await deleteSearchingMsg();
      return;
    }

    pendingMap.set(userId, { videos, thumbnailUrl, qualityLabels, audioAvailable, duration, sizeByQuality });

    const keyboard = buildQualityKeyboard(lang, qualityLabels, audioAvailable);

    await deleteSearchingMsg();
    if (thumbnailUrl) {
      await ctx.replyWithPhoto(thumbnailUrl, { caption, parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
    }
  } catch (error) {
    await deleteSearchingMsg();
    console.error(error);
    const stderr = (error.stderr ?? '').trim();
    const brief = (stderr || (error.message ?? '')).split('\n').filter(l => l.trim()).at(-1)?.slice(0, 200) ?? '';
    await ctx.reply(`${translations[lang].status.error} (${brief})`);
  }
});

async function setupWebhook() {
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    await bot.api.setWebhook(TELEGRAM_WEBHOOK_URL);
    console.log('Webhook set:', TELEGRAM_WEBHOOK_URL);
  } catch (err) {
    console.error('Failed to set webhook:', err);
  }
}

// Start the server
if (process.env.NODE_ENV === 'production') {
  // Use Webhooks for the production server
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
  app.use(webhookCallback(bot, 'express'));

  const PORT = process.env.PORT || 3000;

  app.get('/health', (_req, res) => {
    res.send('Bot is running');
  });

  app.listen(PORT, () => {
    console.log(`Bot listening on port ${PORT}`);
  });

  setupWebhook();
} else {
  // Use Long Polling for development
  bot.start({ drop_pending_updates: true });
}
