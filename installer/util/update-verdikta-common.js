#!/usr/bin/env node

/**
 * Verdikta Common Library Update Utility
 * Checks for and installs updates to the @verdikta/common library
 * to ensure the latest ClassID model pool information is available.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Colors for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
    console.log(`${color}${message}${colors.reset}`);
}

class VerdiktaCommonUpdater {
    constructor(aiNodePath, externalAdapterPath = null) {
        this.aiNodePath = aiNodePath || process.cwd();
        this.externalAdapterPath = externalAdapterPath;
        this.packageJsonPath = path.join(this.aiNodePath, 'package.json');
        this.externalAdapterPackageJsonPath = externalAdapterPath ? 
            path.join(externalAdapterPath, 'package.json') : null;
    }

    async checkCurrentVersion(directoryPath = null) {
        try {
            const targetPath = directoryPath || this.aiNodePath;
            const packageJsonPath = directoryPath ? 
                path.join(directoryPath, 'package.json') : 
                this.packageJsonPath;
                
            if (!fs.existsSync(packageJsonPath)) {
                log(`❌ package.json not found in ${path.basename(targetPath)} directory`, colors.red);
                return null;
            }

            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            const currentVersion = packageJson.dependencies?.['@verdikta/common'] || 
                                 packageJson.devDependencies?.['@verdikta/common'];

            if (!currentVersion) {
                log(`ℹ️  @verdikta/common not currently installed in ${path.basename(targetPath)}`, colors.yellow);
                return null;
            }

            log(`📦 Current @verdikta/common version in ${path.basename(targetPath)}: ${currentVersion}`, colors.blue);
            return currentVersion;
        } catch (error) {
            log(`❌ Error reading package.json in ${path.basename(directoryPath || this.aiNodePath)}: ${error.message}`, colors.red);
            return null;
        }
    }

    async checkAllCurrentVersions() {
        const versions = {};
        
        // Check AI Node version
        versions.aiNode = await this.checkCurrentVersion(this.aiNodePath);
        
        // Check External Adapter version if path provided
        if (this.externalAdapterPath) {
            versions.externalAdapter = await this.checkCurrentVersion(this.externalAdapterPath);
        }
        
        return versions;
    }

    async getLatestVersion(versionTag = 'beta') {
        return new Promise((resolve, reject) => {
            log(`🔍 Checking latest ${versionTag} version of @verdikta/common...`, colors.blue);
            
            const process = spawn('npm', ['view', `@verdikta/common@${versionTag}`, 'version'], {
                stdio: ['inherit', 'pipe', 'pipe'],
                cwd: this.aiNodePath
            });

            let output = '';
            let error = '';

            process.stdout.on('data', (data) => {
                output += data.toString();
            });

            process.stderr.on('data', (data) => {
                error += data.toString();
            });

            process.on('close', (code) => {
                if (code === 0) {
                    const version = output.trim();
                    log(`📋 Latest ${versionTag} version: ${version}`, colors.green);
                    resolve(version);
                } else {
                    log(`❌ Failed to check latest version: ${error}`, colors.red);
                    reject(new Error(error || `Process exited with code ${code}`));
                }
            });

            process.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new Error('npm not found. Please ensure Node.js and npm are installed.'));
                } else {
                    reject(err);
                }
            });
        });
    }

    async installOrUpdate(versionTag = 'beta', force = false, directoryPath = null) {
        return new Promise((resolve, reject) => {
            const targetPath = directoryPath || this.aiNodePath;
            const action = force ? 'Installing' : 'Updating';
            log(`📦 ${action} @verdikta/common@${versionTag} in ${path.basename(targetPath)}...`, colors.blue);
            
            // Use --save to ensure package.json is updated with the new version
            const args = ['install', `@verdikta/common@${versionTag}`, '--save'];
            if (force) {
                args.push('--force');
            }

            const process = spawn('npm', args, {
                stdio: ['inherit', 'pipe', 'pipe'],
                cwd: targetPath
            });

            let output = '';
            let error = '';

            process.stdout.on('data', (data) => {
                const text = data.toString();
                output += text;
                // Show npm output for transparency
                console.log(text.replace(/\n$/, ''));
            });

            process.stderr.on('data', (data) => {
                const text = data.toString();
                error += text;
                // Show npm warnings/errors
                console.error(text.replace(/\n$/, ''));
            });

            process.on('close', async (code) => {
                if (code === 0) {
                    log(`✅ Successfully ${force ? 'installed' : 'updated'} @verdikta/common in ${path.basename(targetPath)}`, colors.green);
                    
                    // Update package.json to pin the new version
                    try {
                        const packageJsonPath = path.join(targetPath, 'package.json');
                        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                        const installedVersion = packageJson.dependencies?.['@verdikta/common'];
                        
                        if (installedVersion) {
                            log(`📝 Updated package.json to pin @verdikta/common@${installedVersion}`, colors.dim);
                        }
                    } catch (pkgError) {
                        log(`⚠️  Could not update package.json: ${pkgError.message}`, colors.yellow);
                        // Don't fail the whole operation if package.json update fails
                    }
                    
                    resolve(true);
                } else {
                    log(`❌ Failed to ${force ? 'install' : 'update'} @verdikta/common in ${path.basename(targetPath)}`, colors.red);
                    reject(new Error(error || `Process exited with code ${code}`));
                }
            });

            process.on('error', (err) => {
                if (err.code === 'ENOENT') {
                    reject(new Error('npm not found. Please ensure Node.js and npm are installed.'));
                } else {
                    reject(err);
                }
            });
        });
    }

    async installOrUpdateAll(versionTag = 'beta', force = false) {
        const results = {};
        
        try {
            // Update AI Node
            log(`\n🔄 Updating AI Node...`, colors.cyan);
            results.aiNode = await this.installOrUpdate(versionTag, force, this.aiNodePath);
            
            // Update External Adapter if path provided
            if (this.externalAdapterPath) {
                log(`\n🔄 Updating External Adapter...`, colors.cyan);
                results.externalAdapter = await this.installOrUpdate(versionTag, force, this.externalAdapterPath);
            }
            
            return results;
        } catch (error) {
            log(`❌ Error updating components: ${error.message}`, colors.red);
            throw error;
        }
    }

    compareVersions(current, latest) {
        // Simple version comparison - handles basic semver
        if (!current || !latest) return false;
        
        // Remove version prefixes like ^, ~, etc.
        const cleanCurrent = current.replace(/^[\^~]/, '');
        const cleanLatest = latest.replace(/^[\^~]/, '');
        
        if (cleanCurrent === cleanLatest) {
            return false; // Same version
        }
        
        // For beta versions, always update to get latest changes
        if (current.includes('beta') || latest.includes('beta')) {
            return true;
        }
        
        const currentParts = cleanCurrent.split('.').map(Number);
        const latestParts = cleanLatest.split('.').map(Number);
        
        for (let i = 0; i < Math.max(currentParts.length, latestParts.length); i++) {
            const currentPart = currentParts[i] || 0;
            const latestPart = latestParts[i] || 0;
            
            if (latestPart > currentPart) return true;
            if (latestPart < currentPart) return false;
        }
        
        return false;
    }

    async updateIfNeeded(versionTag = 'beta', force = false) {
        try {
            log('\n🔄 Checking @verdikta/common library status...', colors.bright + colors.cyan);
            
            // Check current versions in all directories
            const currentVersions = await this.checkAllCurrentVersions();
            
            // Determine if we need to update
            let needsUpdate = force;
            let latestVersion = null;
            
            if (!force) {
                try {
                    latestVersion = await this.getLatestVersion(versionTag);
                    
                    // Check if any component needs updating
                    for (const [component, version] of Object.entries(currentVersions)) {
                        if (!version) {
                            needsUpdate = true;
                            log(`📦 ${component} needs @verdikta/common installation`, colors.yellow);
                        } else if (this.compareVersions(version, latestVersion)) {
                            needsUpdate = true;
                            log(`🔄 ${component} needs update (${version} → ${latestVersion})`, colors.yellow);
                        }
                    }
                } catch (versionCheckError) {
                    log('⚠️  Could not check for updates, using current versions', colors.yellow);
                    log(`   Error: ${versionCheckError.message}`, colors.dim);
                    return { updated: false, action: 'error' };
                }
            }
            
            if (needsUpdate) {
                log('🔄 Updating @verdikta/common in all components...', colors.yellow);
                await this.installOrUpdateAll(versionTag, force);
                
                // Verify all components have the same version
                const updatedVersions = await this.checkAllCurrentVersions();
                const uniqueVersions = [...new Set(Object.values(updatedVersions).filter(v => v))];
                
                if (uniqueVersions.length === 1) {
                    log(`✅ All components updated to @verdikta/common@${uniqueVersions[0]}`, colors.green);
                    return { updated: true, action: 'updated', version: uniqueVersions[0] };
                } else {
                    log(`⚠️  Components have different versions: ${Object.entries(updatedVersions).map(([k,v]) => `${k}:${v}`).join(', ')}`, colors.yellow);
                    return { updated: true, action: 'updated_mixed', versions: updatedVersions };
                }
            } else {
                log('✅ All components are up to date', colors.green);
                return { updated: false, action: 'current', versions: currentVersions };
            }
            
        } catch (error) {
            log(`❌ Error updating @verdikta/common: ${error.message}`, colors.red);
            throw error;
        }
    }
}

// Export for use in other scripts
module.exports = VerdiktaCommonUpdater;

// Run directly if called as script
if (require.main === module) {
    const aiNodePath = process.argv[2] || process.cwd();
    const externalAdapterPath = process.argv[3] || null;
    const versionTag = process.argv[4] || 'latest';
    const force = process.argv.includes('--force');
    
    const updater = new VerdiktaCommonUpdater(aiNodePath, externalAdapterPath);
    updater.updateIfNeeded(versionTag, force)
        .then((result) => {
            if (result.updated) {
                if (result.action === 'updated') {
                    log(`\n🎉 @verdikta/common library updated successfully to v${result.version}!`, colors.green);
                } else if (result.action === 'updated_mixed') {
                    log(`\n⚠️  @verdikta/common library updated but components have different versions`, colors.yellow);
                    log(`   Versions: ${Object.entries(result.versions).map(([k,v]) => `${k}:${v}`).join(', ')}`, colors.dim);
                } else {
                    log(`\n🎉 @verdikta/common library ${result.action} successfully!`, colors.green);
                }
                log('   Latest ClassID model pool data is now available.', colors.dim);
            } else {
                log(`\n✅ @verdikta/common library is up to date`, colors.green);
                if (result.versions) {
                    log(`   Current versions: ${Object.entries(result.versions).map(([k,v]) => `${k}:${v}`).join(', ')}`, colors.dim);
                }
            }
            process.exit(0);
        })
        .catch((error) => {
            log(`\n❌ Failed to update @verdikta/common: ${error.message}`, colors.red);
            process.exit(1);
        });
}


