import fs from 'fs-extra';
import path from 'path';
import chai, { expect } from 'chai';
import Helper from '../e2e-helper';
import * as fixtures from '../fixtures/fixtures';

chai.use(require('chai-fs'));

const barFooV1 = "module.exports = function foo() { return 'got foo'; };";
const barFooV2 = "module.exports = function foo() { return 'got foo v2'; };";

describe('bit use command', function () {
  this.timeout(0);
  const helper = new Helper();
  before(() => {
    helper.reInitLocalScope();
  });
  after(() => {
    helper.destroyEnv();
  });
  describe('for non existing component', () => {
    it('show an error saying the component was not found', () => {
      const output = helper.runWithTryCatch('bit use 1.0.0 utils/non-exist');
      expect(output).to.have.string('error: component "utils/non-exist" was not found');
    });
  });
  describe('after the component was created', () => {
    before(() => {
      helper.createComponentBarFoo(barFooV1);
      helper.addComponentBarFoo();
    });
    it('before tagging it should show an error saying the component was not tagged yet', () => {
      const output = helper.runWithTryCatch('bit use 1.0.0 bar/foo');
      expect(output).to.have.string("component bar/foo doesn't have any version yet");
    });
    describe('after the component was tagged', () => {
      before(() => {
        helper.tagAllWithoutMessage('', '0.0.5');
      });
      describe('using a non-exist version', () => {
        it('should show an error saying the version does not exist', () => {
          const output = helper.runWithTryCatch('bit use 1.0.0 bar/foo');
          expect(output).to.have.string("component bar/foo doesn't have version 1.0.0");
        });
      });
      describe('and component was modified', () => {
        before(() => {
          helper.createComponentBarFoo(barFooV2);
        });
        it('should show an error for now until is implemented', () => {
          const output = helper.runWithTryCatch('bit use 0.0.5 bar/foo');
          expect(output).to.have.string(
            'component bar/foo is modified, merging your changes is not supported just yet, please revert your local changes and try again'
          );
        });
        describe('and tagged again', () => {
          let output;
          before(() => {
            helper.tagAllWithoutMessage('', '0.0.10');
            output = helper.runWithTryCatch('bit use 0.0.5 bar/foo');
          });
          it('should display a successful message', () => {
            expect(output).to.have.string('the following components were switched to version');
            expect(output).to.have.string('0.0.5');
            expect(output).to.have.string('bar/foo');
          });
          it('should revert to v1', () => {
            const fooContent = fs.readFileSync(path.join(helper.localScopePath, 'bar/foo.js'));
            expect(fooContent.toString()).to.equal(barFooV1);
          });
          it('should update bitmap with the used version', () => {
            const bitMap = helper.readBitMap();
            expect(bitMap).to.have.property('bar/foo@0.0.5');
            expect(bitMap).to.not.have.property('bar/foo');
            expect(bitMap).to.not.have.property('bar/foo@0.0.10');
          });
          it('should not show the component as modified', () => {
            const statusOutput = helper.runCmd('bit status');
            expect(statusOutput).to.not.have.string('modified components');
          });
        });
      });
    });
  });
  describe('components with dependencies with multiple versions', () => {
    let localScope;
    before(() => {
      helper.setNewLocalAndRemoteScopes();
      helper.createFile('utils', 'is-type.js', fixtures.isType);
      helper.addComponent('utils/is-type.js');
      helper.createFile('utils', 'is-string.js', fixtures.isString);
      helper.addComponent('utils/is-string.js');
      helper.createComponentBarFoo(fixtures.barFooFixture);
      helper.addComponentBarFoo();
      helper.commitAllComponents();

      helper.createFile('utils', 'is-type.js', fixtures.isTypeV2);
      helper.createFile('utils', 'is-string.js', fixtures.isStringV2);
      helper.createComponentBarFoo(fixtures.barFooFixtureV2);
      helper.commitAllComponents();

      helper.exportAllComponents();
      helper.reInitLocalScope();
      helper.addRemoteScope();
      helper.importComponent('bar/foo');

      fs.outputFileSync(path.join(helper.localScopePath, 'app.js'), fixtures.appPrintBarFoo);
      localScope = helper.cloneLocalScope();
    });
    it('as an intermediate step, make sure all components have v2', () => {
      const result = helper.runCmd('node app.js');
      expect(result.trim()).to.equal('got is-type v2 and got is-string v2 and got foo v2');
    });
    describe('switching to a previous version of the main component', () => {
      let output;
      let bitMap;
      before(() => {
        output = helper.useVersion('0.0.1', 'bar/foo');
        bitMap = helper.readBitMap();
      });
      it('should display a successful message', () => {
        expect(output).to.have.string('the following components were switched to version');
        expect(output).to.have.string('0.0.1');
        expect(output).to.have.string('bar/foo');
      });
      it('should write the files of that version for the main component and its dependencies', () => {
        const result = helper.runCmd('node app.js');
        expect(result.trim()).to.equal('got is-type and got is-string and got foo');
      });
      it('should update bitmap of the main component with the used version', () => {
        expect(bitMap).to.have.property(`${helper.remoteScope}/bar/foo@0.0.1`);
        expect(bitMap).to.not.have.property(`${helper.remoteScope}/bar/foo@0.0.2`);
      });
      it('should add the dependencies to bitmap with their old versions in addition to the current versions', () => {
        expect(bitMap).to.have.property(`${helper.remoteScope}/utils/is-string@0.0.1`);
        expect(bitMap).to.have.property(`${helper.remoteScope}/utils/is-string@0.0.2`);
        expect(bitMap).to.have.property(`${helper.remoteScope}/utils/is-type@0.0.1`);
        expect(bitMap).to.have.property(`${helper.remoteScope}/utils/is-type@0.0.2`);
      });
      it('should not show any component as modified', () => {
        const statusOutput = helper.runCmd('bit status');
        expect(statusOutput).to.not.have.string('modified components');
      });
    });
    describe.skip('importing individually a nested component', () => {
      before(() => {
        helper.getClonedLocalScope(localScope);
        helper.importComponent('utils/is-string');
      });
      // currently it behaves the same as 'bit import' of an older version.
      // it leaves the current version is components dir and write the old version in .dependencies
      // this way if there is another component that depends on the current version of the nested,
      // it won't be broken.
      it('should rewrite the component in components dir or leave it and write the old version in .dependencies?', () => {});
    });
  });
  describe('as AUTHORED when the recent version has new files', () => {
    before(() => {
      helper.reInitLocalScope();
      helper.createComponentBarFoo();
      helper.addComponentBarFoo();
      helper.tagAllWithoutMessage();
      helper.createFile('bar', 'foo2.js');
      helper.addComponentWithOptions('bar', { i: 'bar/foo' });
      helper.tagAllWithoutMessage();

      helper.useVersion('0.0.1', 'bar/foo');
    });
    it('should not delete the new files', () => {
      // because the author may still need them
      expect(path.join(helper.localScopePath, 'bar/foo2.js')).to.be.a.file();
    });
    it('should update bitmap to not track the new files', () => {
      const bitMap = helper.readBitMap();
      expect(bitMap).to.have.property('bar/foo@0.0.1');
      expect(bitMap).to.not.have.property('bar/foo@0.0.2');
      expect(bitMap['bar/foo@0.0.1'].files).to.be.lengthOf(1);
      expect(bitMap['bar/foo@0.0.1'].files[0].name).to.equal('foo.js');
    });
  });
});
