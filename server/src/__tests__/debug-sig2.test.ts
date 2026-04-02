import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { validateDiscordSignature } from "../services/platform/discord-receiver.js";

describe("debug validateDiscordSignature import", () => {
  it("tests imported signature validation", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: 1 });
    const message = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body, "utf8")]);
    const sig = cryptoSign(null, message, privateKey).toString("hex");
    const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const publicKeyHex = der.slice(12).toString("hex");
    
    console.log("sig:", sig.slice(0, 20), "...");
    console.log("publicKeyHex:", publicKeyHex.slice(0, 20), "...");
    
    const result = validateDiscordSignature(Buffer.from(body), timestamp, sig, publicKeyHex);
    console.log("result:", result);
    expect(result).toBe(true);
  });
});
