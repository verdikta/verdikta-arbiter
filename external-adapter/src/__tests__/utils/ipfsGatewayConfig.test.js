// Unit tests for the operator IPFS gateway settings (IPFS_GATEWAY /
// IPFS_GATEWAY_TOKEN) handed to @verdikta/common's createClient.

const { parseGatewayList, buildIpfsGatewayConfig } = require('../../utils/ipfsGatewayConfig');

describe('ipfsGatewayConfig', () => {
  describe('parseGatewayList', () => {
    it('returns an empty list for unset or blank values', () => {
      expect(parseGatewayList(undefined)).toEqual({ gateways: [], rejected: [] });
      expect(parseGatewayList('')).toEqual({ gateways: [], rejected: [] });
      expect(parseGatewayList('  , \n')).toEqual({ gateways: [], rejected: [] });
    });

    it('treats a single URL as a list of one (the historical IPFS_GATEWAY form)', () => {
      expect(parseGatewayList('https://abc-123.mypinata.cloud'))
        .toEqual({ gateways: ['https://abc-123.mypinata.cloud'], rejected: [] });
    });

    it('splits on commas and whitespace, strips trailing slashes and de-duplicates', () => {
      const value = ' https://abc-123.mypinata.cloud/ ,https://ipfs.io\nhttps://abc-123.mypinata.cloud//';
      expect(parseGatewayList(value).gateways)
        .toEqual(['https://abc-123.mypinata.cloud', 'https://ipfs.io']);
    });

    it('keeps a path prefix and a port but rejects non-http(s) and malformed entries', () => {
      const r = parseGatewayList('https://gw.example.com/ipfs-gw, ftp://x, not-a-url, http://ok.local:8080/');
      expect(r.gateways).toEqual(['https://gw.example.com/ipfs-gw', 'http://ok.local:8080']);
      expect(r.rejected).toEqual(['ftp://x', 'not-a-url']);
    });
  });

  describe('buildIpfsGatewayConfig', () => {
    it('yields no ipfs keys when nothing is configured, so the library defaults apply', () => {
      expect(buildIpfsGatewayConfig({})).toEqual({ ipfs: {}, warnings: [] });
    });

    it('passes the gateway list and a trimmed token', () => {
      const env = { IPFS_GATEWAY: 'https://abc-123.mypinata.cloud/', IPFS_GATEWAY_TOKEN: ' gateway-key ' };
      expect(buildIpfsGatewayConfig(env)).toEqual({
        ipfs: { gateways: ['https://abc-123.mypinata.cloud'], gatewayToken: 'gateway-key' },
        warnings: []
      });
    });

    it('warns about rejected entries and about a token without any gateway', () => {
      const r = buildIpfsGatewayConfig({ IPFS_GATEWAY: 'nope', IPFS_GATEWAY_TOKEN: 'gateway-key' });
      expect(r.ipfs).toEqual({ gatewayToken: 'gateway-key' });
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]).toContain('"nope"');
      expect(r.warnings[1]).toContain('IPFS_GATEWAY_TOKEN is set but IPFS_GATEWAY lists no gateway');
    });

    it('warns when the list only reorders gateways the library already tries', () => {
      const builtInGateways = ['https://gateway.pinata.cloud', 'https://ipfs.io', 'https://dweb.link'];
      const stale = buildIpfsGatewayConfig({ IPFS_GATEWAY: 'https://ipfs.io' }, { builtInGateways });
      expect(stale.ipfs.gateways).toEqual(['https://ipfs.io']);
      expect(stale.warnings).toHaveLength(1);
      expect(stale.warnings[0]).toContain('only lists gateways the library already tries');

      const dedicated = buildIpfsGatewayConfig(
        { IPFS_GATEWAY: 'https://abc-123.mypinata.cloud, https://ipfs.io' }, { builtInGateways }
      );
      expect(dedicated.warnings).toEqual([]);
    });

    it('does not warn about reordering when the library list is unknown (older @verdikta/common)', () => {
      expect(buildIpfsGatewayConfig({ IPFS_GATEWAY: 'https://ipfs.io' }).warnings).toEqual([]);
      expect(buildIpfsGatewayConfig({ IPFS_GATEWAY: 'https://ipfs.io' }, { builtInGateways: undefined }).warnings)
        .toEqual([]);
    });
  });
});
