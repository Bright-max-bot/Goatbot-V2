export const config = {
    name: "waifu",
    version: "1.0.0",
    credits: "Bright",
    description: "",
    usage: "waifu",
    cooldown: 5
};

export async function onCall({ message }) {
    if (global.random(0, 5) === 3)
        return message.reply("Love you bakaaa >w<");
    else
        return message.reply("We are just friends 😔");
}