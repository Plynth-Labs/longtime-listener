import { config } from "./config.js";
import { speak, voiceKey } from "./tts.js";

/**
 * Setting a podcast up is a conversation, so the hosts ask the questions out loud.
 *
 * These are fixed lines, rendered once at boot and served from the speech cache,
 * for the same reason the call-in bridges are: they have to be ready the instant
 * the listener finishes answering, and there is nothing to generate. The screen
 * shows the matching question in writing at the same moment.
 *
 * Recording starts only after the line has finished playing — otherwise the host
 * asking the question ends up in the recording of the answer.
 */
export const SETUP_PROMPTS = {
  welcome: {
    speaker: "ari",
    text: "I'm Ari, and Dev's here with me. What are you interested in? Tell us the podcast you want, and once we're on air, use Call in any time to talk to us.",
    question: "What are you interested in?",
    hint: "Tell Ari and Dev the podcast you want.",
  },
  ready: {
    speaker: "dev",
    text: "Whenever you're ready, tell us what you want to hear.",
    question: "Tell us what you want to hear.",
    hint: "Speak naturally — one request is enough.",
  },
  acknowledge: {
    speaker: "ari",
    text: "Sounds good. Let's put the first episode together.",
    question: "Putting your first episode together.",
    hint: "Ari and Dev are shaping the episode now.",
  },
};

export function promptView(key) {
  const prompt = SETUP_PROMPTS[key];
  if (!prompt) return null;
  const host = config.hosts[prompt.speaker];
  return {
    key,
    speaker: prompt.speaker,
    name: host.name,
    text: prompt.text,
    question: prompt.question,
    hint: prompt.hint,
    audio: voiceKey({ text: prompt.text, voice: host.voice, instructions: host.delivery }),
  };
}

export function promptAudio(key) {
  const prompt = SETUP_PROMPTS[key];
  if (!prompt) return null;
  const host = config.hosts[prompt.speaker];
  return speak({ text: prompt.text, voice: host.voice, instructions: host.delivery });
}

export async function warmSetupPrompts() {
  await Promise.allSettled(Object.keys(SETUP_PROMPTS).map((key) => promptAudio(key)));
}
