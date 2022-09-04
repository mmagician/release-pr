import {promises as fs} from 'fs';
import {join, normalize} from 'path';

import {
	setFailed,
	info,
	debug,
	setOutput,
	error as _error,
	warning
} from '@actions/core';
import {exec as _exec, ExecOptions, getExecOutput} from '@actions/exec';
import {getOctokit, context} from '@actions/github';
import {render as _render} from 'ejs';

import getInputs, {InputsType} from './schema';
import {Octokit} from '@octokit/core';

(async () => {
	try {
		const inputs = await getInputs();
		await setGithubUser(inputs.git);

		const octokit = getOctokit(inputs.githubToken);

		const baseBranch =
			inputs.baseBranch || (await getDefaultBranch(octokit));
		const branchName = await makeBranch(inputs.version, inputs.git);

		const crate = await findCrate(inputs.crate);
		const newVersion = await runCargoRelease(
			crate,
			inputs.version,
			branchName
		);

		await pushBranch(branchName);
		await makePR(
			octokit,
			inputs,
			crate,
			baseBranch,
			branchName,
			newVersion
		);
	} catch (error: unknown) {
		if (error instanceof Error) setFailed(error.message);
		else if (typeof error === 'string') setFailed(error);
		else setFailed('An unknown error has occurred');
	}
})();

async function setGithubUser({
	name,
	email
}: {
	name: string;
	email: string;
}): Promise<void> {
	info(`Setting git user details: ${name} <${email}>`);

	await execAndSucceed('git', ['config', 'user.name', name]);
	await execAndSucceed('git', ['config', 'user.email', email]);
}

async function getDefaultBranch(octokit: Octokit): Promise<string> {
	debug("asking github API for repo's default branch");
	const {
		data: {default_branch}
	} = await octokit.request('GET /repos/{owner}/{repo}', context.repo);
	return default_branch;
}

async function makeBranch(
	version: string,
	{
		branchPrefix,
		branchSeparator
	}: {branchPrefix: string; branchSeparator: string}
): Promise<string> {
	const branchName = [branchPrefix, version].join(branchSeparator);
	info(`Creating branch ${branchName}`);

	await execAndSucceed('git', ['switch', '-c', branchName]);
	setOutput('pr-branch', branchName);
	return branchName;
}

interface CrateArgs {
	name?: string | undefined | null;
	path?: string | undefined | null;
}

interface CrateDetails {
	name: string;
	path: string;
	version: string;
}

async function findCrate({name, path}: CrateArgs): Promise<CrateDetails> {
	if (!name && !path) {
		// check for a valid crate at the root
		try {
			return await pkgid();
		} catch (err) {
			_error(
				'No crate found at the root, try specifying crate-name or crate-path.'
			);
			throw err;
		}
	} else if (name && !path) {
		return pkgid({name});
	} else if (!name && path) {
		return pkgid({path});
	} else {
		// check that we can get a valid crate given all the inputs
		try {
			return await pkgid({name, path});
		} catch (err) {
			_error(
				'crate-name and crate-path conflict; prefer only specifying one or fix the mismatch.'
			);
			throw err;
		}
	}
}

async function runCargoRelease(
	crate: CrateDetails,
	version: string,
	branchName: string
): Promise<string> {
	debug('checking for presence of cargo-release');
	if (!(await toolExists('cargo-release'))) {
		warning('cargo-release is not available, attempting to install it');

		if (await toolExists('cargo-binstall')) {
			info('trying to install cargo-release with cargo-binstall');
			await execAndSucceed('cargo', ['binstall', 'cargo-release']);
		} else {
			info('trying to install cargo-release with cargo-install');
			await execAndSucceed('cargo', ['install', 'cargo-release']);
		}
	}

	debug('running cargo release');
	await execAndSucceed(
		'cargo',
		[
			'release',
			'--execute',
			'--no-push',
			'--no-tag',
			'--no-publish',
			'--no-confirm',
			'--verbose',
			// "--config", "release.toml", // keep?
			'--allow-branch',
			branchName,
			'--dependent-version',
			'upgrade',
			version
		],
		{cwd: crate.path}
	);

	debug('checking version after releasing');
	const {version: newVersion} = await pkgid(crate);
	info(`new version: ${newVersion}`);

	if (newVersion === crate.version)
		throw new Error('New and old versions are identical, not proceeding');

	setOutput('version', newVersion);
	return newVersion;
}

async function pushBranch(branchName: string): Promise<void> {
	await execAndSucceed('git', ['push', 'origin', branchName]);
}

async function makePR(
	octokit: Octokit,
	inputs: InputsType,
	crate: CrateDetails,
	baseBranch: string,
	branchName: string,
	newVersion: string
): Promise<void> {
	const {pr} = inputs;
	const vars: TemplateVars = {
		pr,
		crate: {
			name: crate.name,
			path: crate.path
		},
		version: {
			previous: crate.version,
			actual: newVersion,
			desired: inputs.version
		},
		branchName
	};

	debug(`template variables: ${JSON.stringify(vars)}`);

	debug('rendering PR title template');
	const title = render(pr.title, vars);
	debug(`title rendered to "${title}"`);

	vars.title = title;

	let template = pr.template;
	if (pr.templateFile) {
		debug(`reading template from file: ${pr.templateFile}`);
		template = await fs.readFile(pr.templateFile, 'utf-8');
	} else {
		debug('using template from input');
	}

	if (!template?.trim().length) {
		debug('using default template');
		template = await fs.readFile(
			join(__dirname, 'default-template.ejs'),
			'utf-8'
		);
	}

	debug('rendering PR body template');
	const body = render(template, vars);

	debug('making request to github to create PR');
	const {
		data: {url}
	} = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
		...context.repo,
		title,
		body,
		head: branchName,
		base: baseBranch,
		maintainer_can_modify: pr.modifiable,
		draft: pr.draft
	});

	info(`PR opened: ${url}`);
	setOutput('pr-url', url);
}

interface TemplateVars {
	pr: {
		title: string;
		label?: string;
		draft: boolean;
		modifiable: boolean;

		template?: string;
		templateFile?: string;

		mergeStrategy: string;
		releaseNotes: boolean;
	};
	crate: {
		name: string;
		path: string;
	};
	version: {
		previous: string;
		actual: string;
		desired: string;
	};
	branchName: string;
	title?: string;
}

function render(template: string, vars: TemplateVars): string {
	return _render(template, vars);
}

async function execAndSucceed(
	program: string,
	args: string[],
	options: ExecOptions = {}
): Promise<void> {
	debug(`running ${program} with arguments: ${JSON.stringify(args)}`);
	const exit = await _exec(program, args, options);
	if (exit !== 0) throw new Error(`${program} exited with code ${exit}`);
}

async function toolExists(name: string): Promise<boolean> {
	try {
		debug(`running "${name} --help"`);
		const code = await _exec(name, ['--help']);
		debug(`program exited with code ${code}`);
		return code === 0;
	} catch (err) {
		debug(`program errored: ${err}`);
		return false;
	}
}

async function execWithOutput(
	program: string,
	args: string[]
): Promise<string> {
	debug(`running ${program} with arguments: ${JSON.stringify(args)}`);
	const {exitCode, stdout} = await getExecOutput(program, args);
	if (exitCode !== 0)
		throw new Error(`${program} exited with code ${exitCode}`);
	return stdout;
}

type WorkspaceMemberString = `${string} ${string} (${string})`;

async function pkgid(crate: CrateArgs = {}): Promise<CrateDetails> {
	// we actually use cargo-metadata so it works without a Cargo.lock
	// and equally well for single crates and workspace crates, but the
	// API is unchanged from original, like if this was pkgid.

	debug(
		`checking and parsing metadata to find name=${crate.name} path=${crate.path}`
	);

	const cratePath = crate.path && normalize(crate.path);
	debug(`normalize of crate.path: ${cratePath}`);

	const pkgs: WorkspaceMemberString[] = JSON.parse(
		await execWithOutput('cargo', ['metadata', '--format-version=1'])
	)?.workspace_members;
	debug(`got workspace members: ${JSON.stringify(pkgs)}`);

	// only bother looping if we're searching for something
	if (crate.name || crate.path) {
		for (const pkg of pkgs) {
			const parsed = parseWorkspacePkg(pkg);
			if (!parsed) continue;

			if (
				(crate.name && crate.name === parsed.name) ||
				(crate.path && crate.path === parsed.path)
			)
				return parsed;
		}
	} else if (pkgs.length === 1) {
		info('only one crate in workspace, assuming that is it');
		const parsed = parseWorkspacePkg(pkgs[0]);
		if (!parsed) throw new Error('no good crate found');
		return parsed;
	}

	throw new Error('no matching crate found');
}

function parseWorkspacePkg(pkg: string): CrateDetails | null {
	debug(`parsing workspace package: "${pkg}"`);
	const split = pkg.match(/^(\S+) (\S+) \(path\+(file:[/]{2}.+)\)$/);
	if (!split) {
		warning(`could not parse package format: "${pkg}", skipping`);
		return null;
	}

	const [, name, version, url] = split;

	const {protocol, pathname} = new URL(url);
	if (protocol !== 'file:')
		throw new Error('pkgid is returning a non-local crate');

	debug(`got pathname: ${pathname}`);
	const path = normalize(pathname);
	debug(`got normalize: ${path}`);

	debug(`got crate name: ${name}`);
	debug(`got crate version: ${version}`);

	return {name, path, version};
}
