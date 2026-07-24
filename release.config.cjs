module.exports = {
	branches: ["main"],
	tagFormat: "v${version}",
	plugins: [
		[
			"@semantic-release/commit-analyzer",
			{
				releaseRules: [{ type: "ci", release: "patch" }],
			},
		],
		"@semantic-release/release-notes-generator",
		["@semantic-release/npm", { npmPublish: false }],
		[
			"@semantic-release/git",
			{
				assets: ["package.json", "package-lock.json"],
				message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
			},
		],
		[
			"@semantic-release/github",
			{
				failComment: false,
				releasedLabels: false,
				successComment: false,
			},
		],
	],
};
