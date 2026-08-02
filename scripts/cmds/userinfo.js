const config = {
    name: "userinfo",
    aliases: ["ui", "whois"],
    description: "Get information about a user",
    usage: "userinfo [reply to user]",
    cooldown: 5,
    permissions: [0],
    credits: "Bright",
    isAbsolute: true
}

async function onCall({ message, api, getLang }) {
    try {
        let targetID = message.senderID;
        
        if (message.replyToMessage) {
            targetID = message.replyToMessage.senderID;
        }
        
        const userInfo = await api.getUserInfo(targetID);
        const user = userInfo[targetID];
        
        if (!user) {
            return message.reply("User not found.");
        }
        
        const info = `
USER INFORMATION

Name: ${user.name}
User ID: ${user.userID}
Gender: ${user.gender || "Not specified"}
Profile URL: https://facebook.com/${user.userID}
Is Friend: ${user.isFriend ? "Yes" : "No"}
        `;
        
        return message.reply(info.trim());
    } catch (error) {
        console.error("User info error:", error);
        return message.reply("An error occurred while fetching user information.");
    }
}

export default {
    config,
    onCall
}