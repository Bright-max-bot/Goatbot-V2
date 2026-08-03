import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

export const config = {
    name: "pair",
    version: "0.0.1-xaviabot-port",
    description: "Pairing",
    cooldown: 15
};

// ESM has no __dirname — derive it from the module's own URL.
const __dirname = dirname(fileURLToPath(import.meta.url));

// global.assetsPath may not be set (or not set yet) when this module
// loads. Resolve it lazily — inside a function, not at module scope —
// so it's only read once it's actually needed, and fall back to a
// local "assets" folder next to this file if it's still missing.
function getAssetsDir() {
    const dir = global.assetsPath || join(__dirname, "assets");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

function getLovePath() {
    return join(getAssetsDir(), "love_pairing.png");
}

export async function onLoad() {
    await global.downloadFile(getLovePath(), "https://i.ibb.co/2g0wdVV/heart-icon-14.png").catch(console.error);
}

export async function onCall({ message }) {
    try {
        const lovePath = getLovePath();
        const { participantIDs, senderID } = message;
        const botID = api.getCurrentUserID();
        const listUserID = participantIDs.filter(ID => ID != botID && ID != senderID);

        let tle = Math.floor(Math.random() * 101);
        let id = listUserID[Math.floor(Math.random() * listUserID.length)];

        let namee = await global.controllers.Users.getName(senderID);
        let name = await global.controllers.Users.getName(id);

        let arraytag = [
            { id: senderID, tag: namee },
            { id: id, tag: name }
        ]

        // Prefixed with "pair_" so this doesn't collide with another
        // command's cache files for the same user IDs.
        const avtPath = join(global.cachePath, `pair_${senderID}.png`);
        const avtPath2 = join(global.cachePath, `pair_${id}.png`);

        await global.downloadFile(avtPath, global.getAvatarURL(senderID));
        await global.downloadFile(avtPath2, global.getAvatarURL(id));

        let atms = [];

        atms.push(global.reader(avtPath));
        atms.push(global.reader(lovePath));
        atms.push(global.reader(avtPath2));

        let msg = {
            body: `Successful pairing!\nWish you two hundred years of happiness\nDouble ratio: ${tle}%\n${namee} + ${name}`,
            mentions: arraytag,
            attachment: atms
        }
        await message.reply(msg).catch(e => console.error(e));

        global.deleteFile(avtPath);
        global.deleteFile(avtPath2);
    } catch (error) {
        console.log(error);
        message.reply("Error!");
    }
}