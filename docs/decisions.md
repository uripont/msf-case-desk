# Decisions

## Two Effect versions on purpose

Foldkit 0.169 pins `effect` to exactly 4.0.0 in its peer dependencies. Alchemy 2.0.0-beta.84 requires `effect` 4.0.5 or later. They cannot share one version.

The repository therefore uses two:

- `apps/web` and `packages/domain` use `effect@4.0.0`, so the browser bundle and the domain code share one copy.
- The workspace root uses `effect@4.0.6`, only for `alchemy.run.ts`.

This is safe because the infrastructure file does not import the domain package. If that changes, one of the two pins must move first. Re-check this whenever Foldkit or Alchemy is upgraded.

## The root uses TypeScript 6, the packages use TypeScript 7

A transitive dependency of Alchemy (`capnp-es`) declares a peer on TypeScript 5.7 or 6. The root only typechecks one file, so it stays on 6. The packages use 7, as the Foldkit scaffold does.

## One stack at the root

Following Alchemy's single stack layout, one `alchemy.run.ts` deploys everything. Per package stacks can come later if the web app and a future API need separate deploy cadences.

## Domain first, as pure code

The triage engine is a pure function over validated data. It has no clock, no randomness and no I/O, so the same code can run in the browser today and in a Worker or Durable Object later. The simulated clock in the UI is part of the Model for the same reason.

## Synthetic data only

The seed cases are invented and carry no personal data, so the repository can be shared without exposing anything sensitive.

## The design follows MSF's official branding guidelines

Colours, text colours and typography follow the guidelines published by MSF Barcelona-Athens at branding-guidelines.msf.es: white as the main colour, red `#D7211E`, black, and `#414141` for web text. An earlier version used values read from msf.ch (`#EE0000`, `#292929` and a navy), which do not match the guidelines and were replaced.

The typeface, Atlas Grotesk, is licensed and not bundled. The guidelines reserve it for external communications and name Arial for other materials, so the font stack uses Atlas first, then the bundled open-licence Hanken Grotesk, then Arial, until MSF decides.

The footer shows the positive logo in Catalan, and the app uses the organisation's Catalan name, Metges Sense Fronteres. All branding lives in `src/brand.ts` and `src/styles.css`, so another centre can change it in one place. Use of the MSF name and logo is being confirmed with MSF.

## Operational centre is part of the case from the start

Making it a platform for the whole movement is much cheaper if every case carries its operational centre from the first version. Rules are not yet per centre, but the shape of the model already allows it.
