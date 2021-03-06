import is from '@sindresorhus/is';
import { regEx } from '../util/regex';
import * as template from '../util/template';
import { hasValidSchedule, hasValidTimezone } from '../workers/branch/schedule';
import { RenovateConfig, ValidationMessage } from './common';
import { RenovateOptions, getOptions } from './definitions';
import { resolveConfigPresets } from './presets';
import * as managerValidator from './validation-helpers/managers';

const options = getOptions();

let optionTypes: Record<string, RenovateOptions['type']>;

export interface ValidationResult {
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
}

export async function validateConfig(
  config: RenovateConfig,
  isPreset?: boolean,
  parentPath?: string
): Promise<ValidationResult> {
  if (!optionTypes) {
    optionTypes = {};
    options.forEach((option) => {
      optionTypes[option.name] = option.type;
    });
  }
  let errors: ValidationMessage[] = [];
  let warnings: ValidationMessage[] = [];

  function getDeprecationMessage(option: string): string {
    const deprecatedOptions = {
      branchName: `Direct editing of branchName is now deprecated. Please edit branchPrefix, managerBranchPrefix, or branchTopic instead`,
      commitMessage: `Direct editing of commitMessage is now deprecated. Please edit commitMessage's subcomponents instead.`,
      prTitle: `Direct editing of prTitle is now deprecated. Please edit commitMessage subcomponents instead as they will be passed through to prTitle.`,
    };
    return deprecatedOptions[option];
  }

  function isIgnored(key: string): boolean {
    const ignoredNodes = [
      '$schema',
      'prBanner',
      'depType',
      'npmToken',
      'packageFile',
      'forkToken',
      'repository',
      'vulnerabilityAlertsOnly',
      'vulnerabilityAlert',
      'copyLocalLibs', // deprecated - functionality is now enabled by default
      'prBody', // deprecated
    ];
    return ignoredNodes.includes(key);
  }

  function validateAliasObject(key: string, val: object): boolean {
    if (key === 'aliases') {
      for (const value of Object.values(val)) {
        if (!is.urlString(value)) {
          return false;
        }
      }
    }
    return true;
  }

  for (const [key, val] of Object.entries(config)) {
    const currentPath = parentPath ? `${parentPath}.${key}` : key;
    if (
      !isIgnored(key) && // We need to ignore some reserved keys
      !(is as any).function(val) // Ignore all functions
    ) {
      if (getDeprecationMessage(key)) {
        warnings.push({
          depName: 'Deprecation Warning',
          message: getDeprecationMessage(key),
        });
      }
      const templateKeys = [
        'branchName',
        'commitBody',
        'commitMessage',
        'prTitle',
        'semanticCommitScope',
      ];
      if ((key.endsWith('Template') || templateKeys.includes(key)) && val) {
        try {
          let res = template.compile(val.toString(), config);
          res = template.compile(res, config);
          template.compile(res, config);
        } catch (err) {
          errors.push({
            depName: 'Configuration Error',
            message: `Invalid template in config path: ${currentPath}`,
          });
        }
      }
      if (!optionTypes[key]) {
        errors.push({
          depName: 'Configuration Error',
          message: `Invalid configuration option: ${currentPath}`,
        });
      } else if (key === 'schedule') {
        const [validSchedule, errorMessage] = hasValidSchedule(val as string[]);
        if (!validSchedule) {
          errors.push({
            depName: 'Configuration Error',
            message: `Invalid ${currentPath}: \`${errorMessage}\``,
          });
        }
      } else if (
        key === 'allowedVersions' &&
        is.string(val) &&
        val.length > 1 &&
        val.startsWith('/') &&
        val.endsWith('/')
      ) {
        try {
          regEx(val.slice(1, -1));
        } catch (err) {
          errors.push({
            depName: 'Configuration Error',
            message: `Invalid regExp for ${currentPath}: \`${val}\``,
          });
        }
      } else if (
        key === 'allowedVersions' &&
        is.string(val) &&
        val.length > 2 &&
        val.startsWith('!/') &&
        val.endsWith('/')
      ) {
        try {
          regEx(val.slice(2, -1));
        } catch (err) {
          errors.push({
            depName: 'Configuration Error',
            message: `Invalid regExp for ${currentPath}: \`${val}\``,
          });
        }
      } else if (key === 'timezone' && val !== null) {
        const [validTimezone, errorMessage] = hasValidTimezone(val as string);
        if (!validTimezone) {
          errors.push({
            depName: 'Configuration Error',
            message: `${currentPath}: ${errorMessage}`,
          });
        }
      } else if (val != null) {
        const type = optionTypes[key];
        if (type === 'boolean') {
          if (val !== true && val !== false) {
            errors.push({
              depName: 'Configuration Error',
              message: `Configuration option \`${currentPath}\` should be boolean. Found: ${JSON.stringify(
                val
              )} (${typeof val})`,
            });
          }
        } else if (type === 'array' && val) {
          if (!is.array(val)) {
            errors.push({
              depName: 'Configuration Error',
              message: `Configuration option \`${currentPath}\` should be a list (Array)`,
            });
          } else {
            for (const [subIndex, subval] of val.entries()) {
              if (is.object(subval)) {
                const subValidation = await module.exports.validateConfig(
                  subval,
                  isPreset,
                  `${currentPath}[${subIndex}]`
                );
                warnings = warnings.concat(subValidation.warnings);
                errors = errors.concat(subValidation.errors);
              }
            }
            if (key === 'extends') {
              const tzRe = /^:timezone\((.+)\)$/;
              for (const subval of val) {
                if (is.string(subval) && tzRe.test(subval)) {
                  const [, timezone] = tzRe.exec(subval);
                  const [validTimezone, errorMessage] = hasValidTimezone(
                    timezone
                  );
                  if (!validTimezone) {
                    errors.push({
                      depName: 'Configuration Error',
                      message: `${currentPath}: ${errorMessage}`,
                    });
                  }
                }
              }
            }

            const selectors = [
              'paths',
              'languages',
              'baseBranchList',
              'managers',
              'datasources',
              'depTypeList',
              'packageNames',
              'packagePatterns',
              'excludePackageNames',
              'excludePackagePatterns',
              'sourceUrlPrefixes',
              'updateTypes',
            ];
            if (key === 'packageRules') {
              for (const packageRule of val) {
                let hasSelector = false;
                if (is.object(packageRule)) {
                  const resolvedRule = await resolveConfigPresets(
                    packageRule as RenovateConfig,
                    config
                  );
                  errors.push(
                    ...managerValidator.check({ resolvedRule, currentPath })
                  );
                  for (const pKey of Object.keys(resolvedRule)) {
                    if (selectors.includes(pKey)) {
                      hasSelector = true;
                    }
                  }
                  if (!hasSelector) {
                    const message = `${currentPath}: Each packageRule must contain at least one selector (${selectors.join(
                      ', '
                    )}). If you wish for configuration to apply to all packages, it is not necessary to place it inside a packageRule at all.`;
                    errors.push({
                      depName: 'Configuration Error',
                      message,
                    });
                  }
                } else {
                  errors.push({
                    depName: 'Configuration Error',
                    message: `${currentPath} must contain JSON objects`,
                  });
                }
              }
            }
            if (key === 'regexManagers') {
              const allowedKeys = [
                'fileMatch',
                'matchStrings',
                'depNameTemplate',
                'lookupNameTemplate',
                'datasourceTemplate',
                'versioningTemplate',
              ];
              for (const regexManager of val) {
                if (
                  Object.keys(regexManager).some(
                    (k) => !allowedKeys.includes(k)
                  )
                ) {
                  const disallowedKeys = Object.keys(regexManager).filter(
                    (k) => !allowedKeys.includes(k)
                  );
                  errors.push({
                    depName: 'Configuration Error',
                    message: `Regex Manager contains disallowed fields: ${disallowedKeys.join(
                      ', '
                    )}`,
                  });
                } else if (
                  !regexManager.matchStrings ||
                  regexManager.matchStrings.length !== 1
                ) {
                  errors.push({
                    depName: 'Configuration Error',
                    message: `Regex Manager ${currentPath} must contain a matchStrings array of length one`,
                  });
                } else {
                  let validRegex = false;
                  for (const matchString of regexManager.matchStrings) {
                    try {
                      regEx(matchString);
                      validRegex = true;
                    } catch (e) {
                      errors.push({
                        depName: 'Configuration Error',
                        message: `Invalid regExp for ${currentPath}: \`${matchString}\``,
                      });
                    }
                  }
                  if (validRegex) {
                    const mandatoryFields = [
                      'depName',
                      'currentValue',
                      'datasource',
                    ];
                    for (const field of mandatoryFields) {
                      if (
                        !regexManager[`${field}Template`] &&
                        !regexManager.matchStrings.some((matchString) =>
                          matchString.includes(`(?<${field}>`)
                        )
                      ) {
                        errors.push({
                          depName: 'Configuration Error',
                          message: `Regex Managers must contain ${field}Template configuration or regex group named ${field}`,
                        });
                      }
                    }
                  }
                }
              }
            }
            if (key === 'packagePatterns' || key === 'excludePackagePatterns') {
              for (const pattern of val) {
                if (pattern !== '*') {
                  try {
                    regEx(pattern);
                  } catch (e) {
                    errors.push({
                      depName: 'Configuration Error',
                      message: `Invalid regExp for ${currentPath}: \`${pattern}\``,
                    });
                  }
                }
              }
            }
            if (key === 'fileMatch') {
              for (const fileMatch of val) {
                try {
                  regEx(fileMatch);
                } catch (e) {
                  errors.push({
                    depName: 'Configuration Error',
                    message: `Invalid regExp for ${currentPath}: \`${fileMatch}\``,
                  });
                }
              }
            }
            if (
              (selectors.includes(key) || key === 'matchCurrentVersion') &&
              !/p.*Rules\[\d+\]$/.test(parentPath) && // Inside a packageRule
              (parentPath || !isPreset) // top level in a preset
            ) {
              errors.push({
                depName: 'Configuration Error',
                message: `${currentPath}: ${key} should be inside a \`packageRule\` only`,
              });
            }
          }
        } else if (type === 'string') {
          if (!is.string(val)) {
            errors.push({
              depName: 'Configuration Error',
              message: `Configuration option \`${currentPath}\` should be a string`,
            });
          }
        } else if (type === 'object' && currentPath !== 'compatibility') {
          if (is.object(val)) {
            if (key === 'aliases') {
              if (!validateAliasObject(key, val)) {
                errors.push({
                  depName: 'Configuration Error',
                  message: `Invalid alias object configuration`,
                });
              }
            } else {
              const ignoredObjects = options
                .filter((option) => option.freeChoice)
                .map((option) => option.name);
              if (!ignoredObjects.includes(key)) {
                const subValidation = await module.exports.validateConfig(
                  val,
                  isPreset,
                  currentPath
                );
                warnings = warnings.concat(subValidation.warnings);
                errors = errors.concat(subValidation.errors);
              }
            }
          } else {
            errors.push({
              depName: 'Configuration Error',
              message: `Configuration option \`${currentPath}\` should be a json object`,
            });
          }
        }
      }
    }
  }
  function sortAll(a: ValidationMessage, b: ValidationMessage): number {
    // istanbul ignore else: currently never happen
    if (a.depName === b.depName) {
      return a.message > b.message ? 1 : -1;
    }
    // istanbul ignore next: currently never happen
    return a.depName > b.depName ? 1 : -1;
  }
  errors.sort(sortAll);
  warnings.sort(sortAll);
  return { errors, warnings };
}
