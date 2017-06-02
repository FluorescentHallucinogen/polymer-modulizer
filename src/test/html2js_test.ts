import * as esprima from 'esprima';
import * as estree from 'estree';
import * as path from 'path';

import {Analyzer, FSUrlLoader, InMemoryOverlayUrlLoader, Document, UrlLoader, UrlResolver, PackageUrlResolver} from 'polymer-analyzer';
import {AnalysisConverter, getMemberPath} from '../html2js';
import {assert} from 'chai';

suite('html2js', () => {

  suite('html2Js', () => {

    let urlLoader: InMemoryOverlayUrlLoader;
    let analyzer: Analyzer;

    setup(() => {
      urlLoader = new InMemoryOverlayUrlLoader();
      analyzer = new Analyzer({
        urlLoader: urlLoader
      })
    });

    async function getJs() {
      const analysis = await analyzer.analyze(['test.html']);
      const testDoc = analysis.getDocument('test.html') as Document;
      const converter = new AnalysisConverter(analysis);
      converter.convertDocument(testDoc);
      const module = converter.modules.get('./test.js');
      return module && module.source
    }

    function setSources(sources: {[filename: string]: string}) {
      for (const [filename, source] of Object.entries(sources)) {
        urlLoader.urlContentsMap.set(filename, source);
      }
    }

    async function getConverted(): Promise<Map<string, string>> {
      const analysis = await analyzer.analyze(['test.html']);
      const converter = new AnalysisConverter(analysis);
      return converter.convert();
    }

    test('converts imports to .js', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./dep.html">
          <script></script>
        `,
        'dep.html': `<h1>Hi</h1>`,
      });
      assert.equal(await getJs(), `import './dep.js';\n`);
    });

    test('converts imports to .js without scripts', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./dep.html">
        `,
        'dep.html': `<h1>Hi</h1>`,
      });
      assert.equal(await getJs(), `import './dep.js';\n`);
    });

    test('unwraps top-level IIFE', async () => {
      setSources({
        'test.html': `
          <dom-module>
            <template>
              <h1>Test</h1>
            </template>
            <script>
              (function() {
                'use strict';

                Polymer.Foo = 'Bar';
              })();
            </script>
          </dom-module>
        `,
      });
      assert.equal(await getJs(), `export let Foo = 'Bar';\n`);
    });

    test('exports a reference', async () => {
      setSources({
        'test.html': `
          <script>
            (function() {
              'use strict';

              Polymer.ArraySelectorMixin = ArraySelectorMixin;
            })();
          </script>`
      });
      assert.equal(await getJs(),
`export {
  ArraySelectorMixin
};
`);
    });

    test('exports a value to a nested namespace', async () => {
      setSources({
        'test.html': `
          <script>
            (function() {
              window.Polymer.version = '2.0.0';
            })();
          </script>`
      });
      assert.equal(await getJs(), `export let version = '2.0.0';\n`);
    });

    test('exports the result of a funciton call', async () => {
      urlLoader.urlContentsMap.set('test.html', `
          <script>
            Polymer.LegacyElementMixin = Polymer.dedupingMixin();
          </script>`);
      assert.equal(await getJs(), `export let LegacyElementMixin = Polymer.dedupingMixin();\n`);
    });

    test('exports a namespace object\'s properties', async () => {
      setSources({
        'test.html': `
          <script>
            (function() {
              'use strict';
              /**
               * @namespace
               */
              Polymer.Namespace = {
                obj: {},
                meth() {},
                func: function() {},
                arrow: () => {}
              };
            })();
          </script>`,
      });
      assert.equal(await getJs(), `export let obj = {};
export function meth() {
}
export function func() {
}
export let arrow = () => {
};
`);
    });

    test('exports a referenced namespace', async () => {
      setSources({
        'test.html': `
          <script>
            (function() {
              'use strict';
              /**
               * @namespace
               * @memberof Polymer
               */
              const Namespace = {
                obj: {},
              };
              Polymer.Namespace = Namespace;
            })();
          </script>`,
      });
      assert.equal(await getJs(), `export let obj = {};\n`);
    });

    test('specifies referenced imports in import declarations', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./dep.html">
          <script>
            class MyElement extends Polymer.Element {}
          </script>
        `,
        'dep.html': `
          <script>
            Polymer.Element = {};
          </script>
        `,
      });
      const converted = await getConverted();
      const js = converted.get('./test.js');
      assert.equal(js, `import { Element } from './dep.js';
class MyElement extends Element {
}\n`);
    });

    test('uses imports from namespaces', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./dep.html">
          <script>
            class MyElement extends Polymer.Foo.Element {}
          </script>
        `,
        'dep.html': `
          <script>
            /**
             * @namespace
             */
            Polymer.Foo = {
              Element: {},
            };
          </script>
        `,
      });
      const converted = await getConverted();
      const js = converted.get('./test.js');
      assert.equal(js, `import { Element } from './dep.js';
class MyElement extends Element {
}\n`);
    });

    test('rewrites references to namespaces', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./dep.html">
          <script>
            const Foo = Polymer.Foo;
            class MyElement extends Foo.Element {}
          </script>
        `,
        'dep.html': `
          <script>
            /**
             * @namespace
             */
            Polymer.Foo = {
              Element: {},
            };
          </script>
        `,
      });
      const converted = await getConverted();
      const js = converted.get('./test.js');
      assert.equal(js, `import * as $dep from './dep.js';
const Foo = $dep;
class MyElement extends Foo.Element {
}\n`);
    });

    test('excludes excluded files', async () => {
      setSources({
        'test.html': `
          <link rel="import" href="./exclude.html">
          <link rel="import" href="./dep.html">
          <script>
            class MyElement extends Polymer.Element {}
          </script>
        `,
        'dep.html': `
          <script>
            Polymer.Element = {};
          </script>
        `,
        'exclude.html': `
          <script>"no no no";</script>
        `,
      });
      const analysis = await analyzer.analyze(['test.html']);
      const converter = new AnalysisConverter(analysis, {
        excludes: ['exclude.html'],
      });
      const converted = await converter.convert();
      const js = converted.get('./test.js');
      assert.equal(js, `import { Element } from './dep.js';
class MyElement extends Element {
}\n`);
    });

  });

  suite('fixtures', () => {

    let urlResolver: UrlResolver;
    let urlLoader: UrlLoader;
    let analyzer: Analyzer;

    setup(() => {
      urlLoader = new FSUrlLoader(path.resolve(__dirname, '../../fixtures'));
      urlResolver = new PackageUrlResolver();
      analyzer = new Analyzer({
        urlResolver,
        urlLoader,
      });
    });

    test('case-map', async () => {
      const analysis = await analyzer.analyze(['case-map/case-map.html']);
      const converter = new AnalysisConverter(analysis);
      const converted = await converter.convert();
      const caseMapSource = converted.get('./case-map/case-map.js');
      assert.include(caseMapSource!, 'export function dashToCamelCase');
      assert.include(caseMapSource!, 'export function camelToDashCase');
    });

    test('polymer-element', async () => {
      const filename = 'polymer-element/polymer-element.html';
      const analysis = await analyzer.analyze([filename]);
      const doc = analysis.getDocument(filename) as Document;
      const converter = new AnalysisConverter(analysis);
      converter.convertDocument(doc);
      assert(converter.namespacedExports.has('Polymer.Element'));
    });

  });

  suite('getMemberPath', () => {

    function getMemberExpression(source: string) {
      const program = esprima.parse(source);
      const statement = program.body[0] as estree.ExpressionStatement;
      const expression = statement.expression as estree.AssignmentExpression;
      return expression.left as estree.MemberExpression;      
    }

    test('works for a single property access', () => {
      const memberExpression = getMemberExpression(`Foo.Bar = 'A';`);
      const memberPath = getMemberPath(memberExpression);
      assert.deepEqual(memberPath, ['Foo', 'Bar']);
    });

    test('works for chained property access', () => {
      const memberExpression = getMemberExpression(`Foo.Bar.Baz = 'A';`);
      const memberPath = getMemberPath(memberExpression);
      assert.deepEqual(memberPath, ['Foo', 'Bar', 'Baz']);
    });

    test('discards leading `window`', () => {
      const memberExpression = getMemberExpression(`window.Foo.Bar.Baz = 'A';`);
      const memberPath = getMemberPath(memberExpression);
      assert.deepEqual(memberPath, ['Foo', 'Bar', 'Baz']);
    });

  });

});