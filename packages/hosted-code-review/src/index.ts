import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerReviewCommand } from "./command.js";

export default function hostedCodeReviewExtension(pi: ExtensionAPI): void {
	registerReviewCommand(pi);
}
