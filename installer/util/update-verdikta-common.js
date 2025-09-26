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
    constructor(aiNodePath) {
        this.aiNodePath = aiNodePath || process.cwd();
        this.packageJsonPath = path.join(this.aiNodePath, 'package.json');
    }

    async checkCurrentVersion() {
        try {
            if (!fs.existsSync(this.packageJsonPath)) {
                log('❌ package.json not found in AI Node directory', colors.red);
                return null;
            }

            const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf8'));
            const currentVersion = packageJson.dependencies?.['@verdikta/common'] || 
                                 packageJson.devDependencies?.['@verdikta/common'];

            if (!currentVersion) {
                log('ℹ️  @verdikta/common not currently installed', colors.yellow);
                return null;
            }

            log(`📦 Current @verdikta/common version: ${currentVersion}`, colors.blue);
            return currentVersion;
        } catch (error) {
            log(`❌ Error reading package.json: ${error.message}`, colors.red);
            return null;
        }
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

    async installOrUpdate(versionTag = 'beta', force = false) {
        return new Promise((resolve, reject) => {
            const action = force ? 'Installing' : 'Updating';
            log(`📦 ${action} @verdikta/common@${versionTag}...`, colors.blue);
            
            const args = ['install', `@verdikta/common@${versionTag}`];
            if (force) {
                args.push('--force');
            }

            const process = spawn('npm', args, {
                stdio: ['inherit', 'pipe', 'pipe'],
                cwd: this.aiNodePath
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

            process.on('close', (code) => {
                if (code === 0) {
                    log(`✅ Successfully ${force ? 'installed' : 'updated'} @verdikta/common`, colors.green);
                    resolve(true);
                } else {
                    log(`❌ Failed to ${force ? 'install' : 'update'} @verdikta/common`, colors.red);
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
            
            const currentVersion = await this.checkCurrentVersion();
            
            if (!currentVersion || force) {
                log('📦 Installing @verdikta/common...', colors.yellow);
                await this.installOrUpdate(versionTag, true);
                return { updated: true, action: 'installed' };
            }
            
            try {
                const latestVersion = await this.getLatestVersion(versionTag);
                
                if (this.compareVersions(currentVersion, latestVersion)) {
                    log('🔄 Update available! Installing latest version...', colors.yellow);
                    await this.installOrUpdate(versionTag, false);
                    return { updated: true, action: 'updated' };
                } else {
                    log('✅ @verdikta/common is up to date', colors.green);
                    return { updated: false, action: 'current' };
                }
            } catch (versionCheckError) {
                log('⚠️  Could not check for updates, using current version', colors.yellow);
                log(`   Error: ${versionCheckError.message}`, colors.dim);
                return { updated: false, action: 'error' };
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
    const versionTag = process.argv[3] || 'beta';
    const force = process.argv.includes('--force');
    
    const updater = new VerdiktaCommonUpdater(aiNodePath);
    updater.updateIfNeeded(versionTag, force)
        .then((result) => {
            if (result.updated) {
                log(`\n🎉 @verdikta/common library ${result.action} successfully!`, colors.green);
                log('   Latest ClassID model pool data is now available.', colors.dim);
            }
            process.exit(0);
        })
        .catch((error) => {
            log(`\n❌ Failed to update @verdikta/common: ${error.message}`, colors.red);
            process.exit(1);
        });
}

