// Suite group: repository gates (fibjs test runner).
//
// These are the repo-wide consistency gates — theme system + design, settings
// centralization, locale coverage, docs homepage i18n. They used to be
// manual `check:*` scripts; running this suite is now the single way to run
// them. Every gate is pure and hermetic (no browser, no build output), except
// settings-schema, which regenerates the codegen files in memory and restores
// them.
import './theme-system.test.ts';
import './theme-design.test.ts';
import './reading-measure.test.ts';
import './settings-schema.test.ts';
import './i18n-keys.test.ts';
import './homepage-i18n.test.ts';
