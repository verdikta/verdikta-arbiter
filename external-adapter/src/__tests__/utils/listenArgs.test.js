// The optional HOST env of the External Adapter (port-exposure hardening).
// Unset must stay "every interface": Chainlink reaches the adapter through the
// host's own address.

const { listenArgs } = require('../../utils/listenArgs');

describe('listenArgs', () => {
  it('listens on every interface by default (no host argument)', () => {
    expect(listenArgs({})).toEqual([8080]);
    expect(listenArgs({ PORT: '9090' })).toEqual(['9090']);
  });

  it('treats a blank HOST like an unset one', () => {
    expect(listenArgs({ HOST: '' })).toEqual([8080]);
    expect(listenArgs({ HOST: '   ' })).toEqual([8080]);
  });

  it('treats wildcard values as "every interface, as before"', () => {
    // install-adapter.sh writes HOST=0.0.0.0 into every install's .env; honouring it
    // verbatim would turn the dual-stack listener into an IPv4-only one.
    for (const wildcard of ['0.0.0.0', '::', '[::]', '*', ' 0.0.0.0 ']) {
      expect(listenArgs({ HOST: wildcard })).toEqual([8080]);
    }
  });

  it('binds the given address when HOST is set', () => {
    expect(listenArgs({ HOST: '172.17.0.1' })).toEqual([8080, '172.17.0.1']);
    expect(listenArgs({ PORT: '8081', HOST: ' 127.0.0.1 ' })).toEqual(['8081', '127.0.0.1']);
  });

  it('really binds only that address (and the default listener when unset or a wildcard)', (done) => {
    const net = require('net');
    const loop = net.createServer();
    loop.listen(...listenArgs({ PORT: '0', HOST: '127.0.0.1' }), () => {
      expect(loop.address().address).toBe('127.0.0.1');
      loop.close(() => {
        const unset = net.createServer();
        unset.listen(...listenArgs({ PORT: '0' }), () => {
          const defaultAddress = unset.address().address;
          expect(['::', '0.0.0.0']).toContain(defaultAddress);
          unset.close(() => {
            // the HOST=0.0.0.0 every installer-written .env carries must give the SAME listener
            const wild = net.createServer();
            wild.listen(...listenArgs({ PORT: '0', HOST: '0.0.0.0' }), () => {
              expect(wild.address().address).toBe(defaultAddress);
              wild.close(done);
            });
          });
        });
      });
    });
  });
});
