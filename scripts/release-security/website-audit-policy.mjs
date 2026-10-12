import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Docusaurus 3.10.2 currently reports one unpatched braces advisory through
// this exact production dependency fan-out. Bind the exception to the complete
// npm audit report and exact lock graph so omissions and artifact drift fail closed.
const POLICIES = {
  "@docusaurus/babel": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/babel",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/babel/-/babel-3.10.2.tgz",
        "integrity": "sha512-aJ1hpGyvfkte3dDAfNbWM4biW4yWZBVz7TIGLZP+v+tWOBgxX3e0N5ZIXHIvmfNNXTI77pcHUx3KmtOk05Ze3Q=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/bundler",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/babel",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/utils"
      ],
      "effects": [
        "@docusaurus/core"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/babel"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/bundler": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/bundler",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/bundler/-/bundler-3.10.2.tgz",
        "integrity": "sha512-i0ZNcy0f0WhaOlYVgzLsWhIoEXO9kS3HRoKPtgE6vQtZUq7arKZaYdNBudr3mqCmd+TyOkwtwfHgs1ENj07r5g=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/bundler",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/babel",
        "@docusaurus/utils",
        "copy-webpack-plugin"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/bundler"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/core": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/core",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/core/-/core-3.10.2.tgz",
        "integrity": "sha512-EYByj6nk+aD9KeVxV6Hmo2/nAAT79P21Y82ycTBOBtrmqilloIbIEhgL2/8Xpt2Jz/pgNqHAwyusOGwmbKeJmA=="
      }
    ],
    "edges": [
      {
        "node": "",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-client-redirects",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-pages",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-css-cascade-layers",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-debug",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-analytics",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-gtag",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-tag-manager",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-sitemap",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-svgr",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-mermaid",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/core",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@docusaurus/babel",
        "@docusaurus/bundler",
        "@docusaurus/mdx-loader",
        "@docusaurus/utils",
        "@docusaurus/utils-validation",
        "chokidar",
        "webpack-dev-server"
      ],
      "effects": [
        "@docusaurus/plugin-client-redirects",
        "@docusaurus/plugin-content-blog",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/plugin-content-pages",
        "@docusaurus/plugin-css-cascade-layers",
        "@docusaurus/plugin-debug",
        "@docusaurus/plugin-google-analytics",
        "@docusaurus/plugin-google-gtag",
        "@docusaurus/plugin-google-tag-manager",
        "@docusaurus/plugin-sitemap",
        "@docusaurus/plugin-svgr",
        "@docusaurus/preset-classic",
        "@docusaurus/theme-classic",
        "@docusaurus/theme-mermaid",
        "@docusaurus/theme-search-algolia"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/core"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/mdx-loader": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/mdx-loader",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/mdx-loader/-/mdx-loader-3.10.2.tgz",
        "integrity": "sha512-9Fd4V/SFjfrVQ0JH5EN0+iPWyFunvTeQE3gfyFeetqPaXMP0OylIjOw16dCuXG4NZJrYdBqwzjh18/h3gRi47w=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-pages",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-common",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/mdx-loader",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/mdx-loader"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-client-redirects": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-client-redirects",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-client-redirects/-/plugin-client-redirects-3.10.2.tgz",
        "integrity": "sha512-z5I5ttCXw+8y2gHVZvqAMmUw4Rb0ZzKA5eCPk87SfM/jCKOTvE24yDpPAwwipvug96ij7mOwEHXWw8G4LlWdGA=="
      }
    ],
    "edges": [
      {
        "node": "",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-client-redirects",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-client-redirects"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/plugin-content-blog": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-content-blog/-/plugin-content-blog-3.10.2.tgz",
        "integrity": "sha512-0cbEnNKf0InmLkhj/+nVRmqEnWEoOE8Mh+2x1qOXI0qYpCnphq4RXknVJ8BvybKRXqYVvbmdMfiJSup+k4tm5w=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-content-blog",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/mdx-loader",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/theme-common",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-content-blog"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-content-docs": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-content-docs/-/plugin-content-docs-3.10.2.tgz",
        "integrity": "sha512-Sqwl4FPoZBDrlY8I2VU2H8O0M91CHp9T8ToMSkTZmjvHCif+1laqfXi6sTk8IfyVS/trN5yNjcWd1bFsGB6W5Q=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "peerDependencies",
        "spec": "*"
      },
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-common",
        "section": "peerDependencies",
        "spec": "*"
      },
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-content-docs",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/mdx-loader",
        "@docusaurus/theme-common",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [
        "@docusaurus/plugin-content-blog",
        "@docusaurus/theme-common"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-content-docs"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-content-pages": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-content-pages",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-content-pages/-/plugin-content-pages-3.10.2.tgz",
        "integrity": "sha512-h5R12sZ/vV9EPiVjvIl9YFCOwkpwXes7dQMYt3EvP6Pphu4amHxxTqWxf08Fl5DR8h+oZMbWpFTNw5vKEYfvzQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-content-pages",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/mdx-loader",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-content-pages"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-css-cascade-layers": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-css-cascade-layers",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-css-cascade-layers/-/plugin-css-cascade-layers-3.10.2.tgz",
        "integrity": "sha512-UkdvQby5OQUKWrw3lLnSTJXQ6VETaUVTuPQX9AABtmFm5h+ifEBx1OQ+LN726Q4byuwBf2ElHkf4qU4hTxdvRg=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-css-cascade-layers",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [
        "@docusaurus/preset-classic"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-css-cascade-layers"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/plugin-debug": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-debug",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-debug/-/plugin-debug-3.10.2.tgz",
        "integrity": "sha512-8vbZNOSCpnsT57EY6CgN7sgRVmx3KTYwO8Uvo2pbxOyb8tbqAwtT9SslqaQ41HbA1v1hpn5RP7u5s2KvRwAFpQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-debug",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-debug"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-google-analytics": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-google-analytics",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-google-analytics/-/plugin-google-analytics-3.10.2.tgz",
        "integrity": "sha512-kMHMBK9j4VAtgd5owwrRLRIi0EjkrpXlX7ePj1+y68XfVZV9I1T4S+koPDm+Hfw2TtnyHvh0uNrDvjz+DjQGVA=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-google-analytics",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils-validation"
      ],
      "effects": [
        "@docusaurus/preset-classic"
      ],
      "range": "*",
      "nodes": [
        "node_modules/@docusaurus/plugin-google-analytics"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/plugin-google-gtag": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-google-gtag",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-google-gtag/-/plugin-google-gtag-3.10.2.tgz",
        "integrity": "sha512-Vt90nNFhtAChRe9+it1hcHFgFvETdSnOkL5Bma+p6E/yU2tAYrvvyk+gv+LJGM2ZUkyKuKXLRsZ2Lb0bO7+Vog=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-google-gtag",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-google-gtag"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-google-tag-manager": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-google-tag-manager",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-google-tag-manager/-/plugin-google-tag-manager-3.10.2.tgz",
        "integrity": "sha512-MLCffCldysi/R0nzJQP7ZWd0xAoGNnSTiVOo6TTR6mKVGFhE+/XArGe67ZcaZv1uytgQXoXs92VJrgVDrz80rQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-google-tag-manager",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils-validation"
      ],
      "effects": [
        "@docusaurus/preset-classic"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-google-tag-manager"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/plugin-sitemap": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-sitemap",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-sitemap/-/plugin-sitemap-3.10.2.tgz",
        "integrity": "sha512-PODkwg5XetLML3hU/3xpCKJUZ9cqExLaBnD/Fzzwj2VHogLeqnDisLIujae87zuze7T4mCm2A6KEqZkyiz07EQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-sitemap",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-sitemap"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/plugin-svgr": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/plugin-svgr",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/plugin-svgr/-/plugin-svgr-3.10.2.tgz",
        "integrity": "sha512-JgfT3jWM0TJ8Uw0cEcqxHpybngQY1vlBYpuuNO+gEh5iPh5Ar+vxq/u9CFrYsWeXy48BN7Db76Pzp2edNXUQ8A=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/plugin-svgr",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [
        "@docusaurus/preset-classic"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/plugin-svgr"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/preset-classic": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/preset-classic/-/preset-classic-3.10.2.tgz",
        "integrity": "sha512-a4B3VczmDl99zK0EufDQYomdJ186WDingjmDXxhN2PNPS9Ty/Y2M5CLFX1KQMRKqRTLiRDKfutzG5IY1FC/ceg=="
      }
    ],
    "edges": [
      {
        "node": "",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/preset-classic",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@docusaurus/core",
        "@docusaurus/plugin-content-blog",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/plugin-content-pages",
        "@docusaurus/plugin-css-cascade-layers",
        "@docusaurus/plugin-debug",
        "@docusaurus/plugin-google-analytics",
        "@docusaurus/plugin-google-gtag",
        "@docusaurus/plugin-google-tag-manager",
        "@docusaurus/plugin-sitemap",
        "@docusaurus/plugin-svgr",
        "@docusaurus/theme-classic",
        "@docusaurus/theme-common",
        "@docusaurus/theme-search-algolia"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/preset-classic"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/theme-classic": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/theme-classic/-/theme-classic-3.10.2.tgz",
        "integrity": "sha512-JqTSLQmqmA9uKWZsD5iwBGJ4JyKB4/yTw6PsSXVPRJG/6GAm/u+add9Iip+hvwP12/AnPNztrdxsI14NJW4KeA=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/theme-classic",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/mdx-loader",
        "@docusaurus/plugin-content-blog",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/plugin-content-pages",
        "@docusaurus/theme-common",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/theme-classic"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/theme-common": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/theme-common",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/theme-common/-/theme-common-3.10.2.tgz",
        "integrity": "sha512-R9b/vMpK1yye6hNZTA6x/ivRv+at6GhxnXcxkpzCGzO1R1RwiquqiFg2wMFh6aqlJTpWRFKpFD2TzCDQcyOU0A=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-mermaid",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/theme-common",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/mdx-loader",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/utils"
      ],
      "effects": [
        "@docusaurus/plugin-content-blog",
        "@docusaurus/plugin-content-docs"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/theme-common"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/theme-mermaid": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/theme-mermaid",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/theme-mermaid/-/theme-mermaid-3.10.2.tgz",
        "integrity": "sha512-Stssh5MYQJ+EdYugUXf+ZcpeJFQPKXf0KCd/SWp10o3CmXNaOoh5IEgVjVqY1e1XhQf3on4+Y4BnrMiD95E2SQ=="
      }
    ],
    "edges": [
      {
        "node": "",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/theme-mermaid",
      "severity": "high",
      "isDirect": true,
      "via": [
        "@docusaurus/core",
        "@docusaurus/theme-common",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/theme-mermaid"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/theme-search-algolia": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/theme-search-algolia/-/theme-search-algolia-3.10.2.tgz",
        "integrity": "sha512-1msxllyhi/5m77JukXtp5UFnUAriwZIC1oJ7MTnpQpCwLTbclJi5BK5n28CTZuSXpQN2ewbbnqRgAhMM6c6ihg=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/preset-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/theme-search-algolia",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/core",
        "@docusaurus/plugin-content-docs",
        "@docusaurus/theme-common",
        "@docusaurus/utils",
        "@docusaurus/utils-validation"
      ],
      "effects": [],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/theme-search-algolia"
      ],
      "fixAvailable": true
    }
  },
  "@docusaurus/utils": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/utils",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/utils/-/utils-3.10.2.tgz",
        "integrity": "sha512-xx0W3eav2uW1NRIpuHJWNwLTC15xPNjU4Uxi9NSnd3swYC96BE3vFiT93SD8s24kmAAWNwgZwfZ2fghGZ01Lcw=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/babel",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/bundler",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/mdx-loader",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-client-redirects",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-pages",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-css-cascade-layers",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-debug",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-sitemap",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-svgr",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-common",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/utils-validation",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/utils",
      "severity": "high",
      "isDirect": false,
      "via": [
        "globby",
        "micromatch"
      ],
      "effects": [
        "@docusaurus/babel",
        "@docusaurus/bundler",
        "@docusaurus/mdx-loader",
        "@docusaurus/plugin-css-cascade-layers",
        "@docusaurus/theme-common",
        "@docusaurus/utils-validation"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/utils"
      ],
      "fixAvailable": false
    }
  },
  "@docusaurus/utils-validation": {
    "artifacts": [
      {
        "node": "node_modules/@docusaurus/utils-validation",
        "version": "3.10.2",
        "resolved": "https://registry.npmjs.org/@docusaurus/utils-validation/-/utils-validation-3.10.2.tgz",
        "integrity": "sha512-sn8unbDfUL585NtR3cwHefPicOyaHvPaX7VD0aOg/siIxUBoKyKKaGEqzJZDS64mM43TnxurkYDtmB1wsJlZsw=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/mdx-loader",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-client-redirects",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-blog",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-docs",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-content-pages",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-css-cascade-layers",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-analytics",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-gtag",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-google-tag-manager",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-sitemap",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/plugin-svgr",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-classic",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-mermaid",
        "section": "dependencies",
        "spec": "3.10.2"
      },
      {
        "node": "node_modules/@docusaurus/theme-search-algolia",
        "section": "dependencies",
        "spec": "3.10.2"
      }
    ],
    "finding": {
      "name": "@docusaurus/utils-validation",
      "severity": "high",
      "isDirect": false,
      "via": [
        "@docusaurus/utils"
      ],
      "effects": [
        "@docusaurus/mdx-loader"
      ],
      "range": "<=4.0.0-canary-6835",
      "nodes": [
        "node_modules/@docusaurus/utils-validation"
      ],
      "fixAvailable": true
    }
  },
  "braces": {
    "artifacts": [
      {
        "node": "node_modules/braces",
        "version": "3.0.3",
        "resolved": "https://registry.npmjs.org/braces/-/braces-3.0.3.tgz",
        "integrity": "sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/chokidar",
        "section": "dependencies",
        "spec": "~3.0.2"
      },
      {
        "node": "node_modules/micromatch",
        "section": "dependencies",
        "spec": "^3.0.3"
      }
    ],
    "finding": {
      "name": "braces",
      "severity": "high",
      "isDirect": false,
      "via": [
        {
          "source": 1240992,
          "name": "braces",
          "dependency": "braces",
          "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
          "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
          "severity": "high",
          "cwe": [
            "CWE-674"
          ],
          "cvss": {
            "score": 7.5,
            "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H"
          },
          "range": "<=3.0.3"
        }
      ],
      "effects": [
        "chokidar",
        "micromatch"
      ],
      "range": "*",
      "nodes": [
        "node_modules/braces"
      ],
      "fixAvailable": false
    }
  },
  "chokidar": {
    "artifacts": [
      {
        "node": "node_modules/chokidar",
        "version": "3.6.0",
        "resolved": "https://registry.npmjs.org/chokidar/-/chokidar-3.6.0.tgz",
        "integrity": "sha512-7VT13fmjotKpGipCW9JEQAusEPE+Ei8nl6/g4FBAmIm0GOOLMua9NDDo/DWp0ZAxCr3cPq5ZpBqmPAQgDda2Pw=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "^3.5.3"
      },
      {
        "node": "node_modules/webpack-dev-server",
        "section": "dependencies",
        "spec": "^3.6.0"
      }
    ],
    "finding": {
      "name": "chokidar",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "@docusaurus/core",
        "webpack-dev-server"
      ],
      "range": "2.0.0 - 3.6.0",
      "nodes": [
        "node_modules/chokidar"
      ],
      "fixAvailable": false
    }
  },
  "copy-webpack-plugin": {
    "artifacts": [
      {
        "node": "node_modules/copy-webpack-plugin",
        "version": "11.0.0",
        "resolved": "https://registry.npmjs.org/copy-webpack-plugin/-/copy-webpack-plugin-11.0.0.tgz",
        "integrity": "sha512-fX2MWpamkW0hZxMEg0+mYnA40LTosOSa5TqZ9GYIBzyJa9C3QUaMPSE2xAi/buNr8u89SfD9wHSQVBzrRa/SOQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/bundler",
        "section": "dependencies",
        "spec": "^11.0.0"
      }
    ],
    "finding": {
      "name": "copy-webpack-plugin",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob",
        "globby"
      ],
      "effects": [
        "@docusaurus/bundler"
      ],
      "range": "6.0.0 - 12.0.2",
      "nodes": [
        "node_modules/copy-webpack-plugin"
      ],
      "fixAvailable": true
    }
  },
  "fast-glob": {
    "artifacts": [
      {
        "node": "node_modules/fast-glob",
        "version": "3.3.3",
        "resolved": "https://registry.npmjs.org/fast-glob/-/fast-glob-3.3.3.tgz",
        "integrity": "sha512-7MptL8U0cqcFdzIzwOTHoilX9x5BrNqye7Z/LuC7kCMRio1EMSyqRK3BEAUD7sXRq4iT4AzTVuZdhgQ2TCvYLg=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/copy-webpack-plugin",
        "section": "dependencies",
        "spec": "^3.2.11"
      },
      {
        "node": "node_modules/copy-webpack-plugin/node_modules/globby",
        "section": "dependencies",
        "spec": "^3.3.0"
      },
      {
        "node": "node_modules/globby",
        "section": "dependencies",
        "spec": "^3.2.9"
      }
    ],
    "finding": {
      "name": "fast-glob",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "copy-webpack-plugin",
        "globby"
      ],
      "range": "*",
      "nodes": [
        "node_modules/fast-glob"
      ],
      "fixAvailable": false
    }
  },
  "globby": {
    "artifacts": [
      {
        "node": "node_modules/copy-webpack-plugin/node_modules/globby",
        "version": "13.2.2",
        "resolved": "https://registry.npmjs.org/globby/-/globby-13.2.2.tgz",
        "integrity": "sha512-Y1zNGV+pzQdh7H39l9zgB4PJqjRNqydvdYCDG4HFXM4XuvSaQQlEc91IU1yALL8gUTDomgBAfz3XJdmUS+oo0w=="
      },
      {
        "node": "node_modules/globby",
        "version": "11.1.0",
        "resolved": "https://registry.npmjs.org/globby/-/globby-11.1.0.tgz",
        "integrity": "sha512-jhIXaOzy1sb8IyocaruWSn1TjmnBVs8Ayhcy83rmxNJ8q2uWKCAj3CnJY+KpGSXCueAPc0i05kVvVKtP1t9S3g=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/utils",
        "section": "dependencies",
        "spec": "^11.1.0"
      },
      {
        "node": "node_modules/copy-webpack-plugin",
        "section": "dependencies",
        "spec": "^13.1.1"
      }
    ],
    "finding": {
      "name": "globby",
      "severity": "high",
      "isDirect": false,
      "via": [
        "fast-glob"
      ],
      "effects": [
        "@docusaurus/utils",
        "copy-webpack-plugin"
      ],
      "range": ">=8.0.0",
      "nodes": [
        "node_modules/copy-webpack-plugin/node_modules/globby",
        "node_modules/globby"
      ],
      "fixAvailable": false
    }
  },
  "http-proxy-middleware": {
    "artifacts": [
      {
        "node": "node_modules/http-proxy-middleware",
        "version": "2.0.10",
        "resolved": "https://registry.npmjs.org/http-proxy-middleware/-/http-proxy-middleware-2.0.10.tgz",
        "integrity": "sha512-RKzRWNPxUZqbuk3BC5mGVJbBnWgr+diEnjJexIOytFbBzDy88Fbh/YvBr3DsNrl1jYAfjWfpATEv0NO35FDuPQ=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/webpack-dev-server",
        "section": "dependencies",
        "spec": "^2.0.9"
      }
    ],
    "finding": {
      "name": "http-proxy-middleware",
      "severity": "high",
      "isDirect": false,
      "via": [
        "micromatch"
      ],
      "effects": [
        "webpack-dev-server"
      ],
      "range": ">=0.3.0",
      "nodes": [
        "node_modules/http-proxy-middleware"
      ],
      "fixAvailable": false
    }
  },
  "micromatch": {
    "artifacts": [
      {
        "node": "node_modules/micromatch",
        "version": "4.0.8",
        "resolved": "https://registry.npmjs.org/micromatch/-/micromatch-4.0.8.tgz",
        "integrity": "sha512-PXwfBhYu0hBCPw8Dn0E+WDYb7af3dSLVWKi3HGv84IdF4TyFoC0ysxFd0Goxw7nSv4T/PzEJQxsYsEiFCKo2BA=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/utils",
        "section": "dependencies",
        "spec": "^4.0.5"
      },
      {
        "node": "node_modules/fast-glob",
        "section": "dependencies",
        "spec": "^4.0.8"
      },
      {
        "node": "node_modules/http-proxy-middleware",
        "section": "dependencies",
        "spec": "^4.0.2"
      }
    ],
    "finding": {
      "name": "micromatch",
      "severity": "high",
      "isDirect": false,
      "via": [
        "braces"
      ],
      "effects": [
        "@docusaurus/utils",
        "fast-glob",
        "http-proxy-middleware"
      ],
      "range": ">=0.2.0",
      "nodes": [
        "node_modules/micromatch"
      ],
      "fixAvailable": false
    }
  },
  "webpack-dev-server": {
    "artifacts": [
      {
        "node": "node_modules/webpack-dev-server",
        "version": "5.2.6",
        "resolved": "https://registry.npmjs.org/webpack-dev-server/-/webpack-dev-server-5.2.6.tgz",
        "integrity": "sha512-HNLRmamRvVavZQ+avceZifmv8hmdUjg43t6MI4SqJDwFdW7RPQwH5vzGhDRZSX59SgfbeHhLnq3g+uooWo7pVw=="
      }
    ],
    "edges": [
      {
        "node": "node_modules/@docusaurus/core",
        "section": "dependencies",
        "spec": "^5.2.2"
      }
    ],
    "finding": {
      "name": "webpack-dev-server",
      "severity": "high",
      "isDirect": false,
      "via": [
        "chokidar",
        "http-proxy-middleware"
      ],
      "effects": [
        "@docusaurus/core"
      ],
      "range": ">=1.15.0",
      "nodes": [
        "node_modules/webpack-dev-server"
      ],
      "fixAvailable": false
    }
  }
}

const FIXED_ARTIFACTS = {
  "http-cache-semantics": {
    "node": "node_modules/http-cache-semantics",
    "version": "4.3.0",
    "resolved": "https://registry.npmjs.org/http-cache-semantics/-/http-cache-semantics-4.3.0.tgz",
    "integrity": "sha512-M5t5LlJpS1UHMjvwRQVdFHvPISGeLAxNcrWuJkeGh0KxsqCHZ1O3NXZU/8x7cD0BDcGW8kapxMKTvwlqrNkHkA=="
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

function sameValue(actual, expected) {
  return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected))
}

function sameArrayMembers(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false
  const normalized = values => values.map(value => JSON.stringify(canonical(value))).sort()
  return sameValue(normalized(actual), normalized(expected))
}

function incomingEdges(packages, dependencyName) {
  const edges = []
  for (const [node, locked] of Object.entries(packages)) {
    if (!isRecord(locked)) continue
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const dependencies = locked[section]
      if (isRecord(dependencies) && Object.hasOwn(dependencies, dependencyName)) {
        edges.push({ node, section, spec: dependencies[dependencyName] })
      }
    }
  }
  return edges.sort((left, right) =>
    `${left.node}:${left.section}:${left.spec}`.localeCompare(`${right.node}:${right.section}:${right.spec}`)
  )
}

function validateArtifact(name, expected, packages, errors) {
  const locked = packages[expected.node]
  if (!isRecord(locked)) {
    errors.push(`${name} lockfile node is missing: ${expected.node}`)
    return
  }
  if (locked.version !== expected.version) {
    errors.push(`${name} version changed from reviewed ${expected.version} to ${locked.version ?? '<missing>'}`)
  }
  if (locked.resolved !== expected.resolved) {
    errors.push(`${name} registry identity changed or is missing at ${expected.node}`)
  }
  if (locked.integrity !== expected.integrity) {
    errors.push(`${name} integrity changed or is missing at ${expected.node}`)
  }
  if (expected.dev === true && locked.dev !== true) {
    errors.push(`${name} is not development only at ${expected.node}`)
  }
}

function validatePolicyLock(packages, errors) {
  for (const [name, policy] of Object.entries(POLICIES)) {
    for (const artifact of policy.artifacts) validateArtifact(name, artifact, packages, errors)
    const actualEdges = incomingEdges(packages, name)
    const expectedEdges = [...policy.edges].sort((left, right) =>
      `${left.node}:${left.section}:${left.spec}`.localeCompare(`${right.node}:${right.section}:${right.spec}`)
    )
    if (!sameValue(actualEdges, expectedEdges)) {
      errors.push(`${name} appeared at an unreviewed dependency edge or lost a reviewed edge`)
    }
  }
}

export function validateWebsiteLock(lock) {
  const errors = []
  const packages = isRecord(lock?.packages) ? lock.packages : null

  if (!packages) return ['missing lockfile package map']
  validatePolicyLock(packages, errors)
  for (const [name, artifact] of Object.entries(FIXED_ARTIFACTS)) {
    validateArtifact(name, artifact, packages, errors)
  }
  return errors
}

function validateCounts(counts, vulnerabilities, errors) {
  const severities = ['info', 'low', 'moderate', 'high', 'critical']
  const expectedCountKeys = [...severities, 'total'].sort()
  if (!sameValue(Object.keys(counts).sort(), expectedCountKeys)) {
    errors.push('audit metadata vulnerability counts have missing or unexpected fields')
  }
  for (const severity of [...severities, 'total']) {
    const count = counts[severity]
    if (!Number.isInteger(count) || count < 0) errors.push(`invalid audit metadata count for ${severity}`)
  }

  const derived = Object.fromEntries(severities.map(severity => [severity, 0]))
  for (const finding of Object.values(vulnerabilities)) {
    if (isRecord(finding) && severities.includes(finding.severity)) derived[finding.severity] += 1
  }
  for (const severity of severities) {
    if (Number.isInteger(counts[severity]) && counts[severity] !== derived[severity]) {
      errors.push(`audit metadata ${severity} count ${counts[severity]} does not match findings ${derived[severity]}`)
    }
  }
  if (Number.isInteger(counts.total) && counts.total !== Object.keys(vulnerabilities).length) {
    errors.push(`audit metadata total ${counts.total} does not match vulnerability map size ${Object.keys(vulnerabilities).length}`)
  }
  if (
    severities.every(severity => Number.isInteger(counts[severity])) &&
    Number.isInteger(counts.total) &&
    counts.total !== severities.reduce((total, severity) => total + counts[severity], 0)
  ) {
    errors.push('audit metadata total does not equal the sum of severity counts')
  }
  if (Number(counts.critical ?? 0) > 0) errors.push(`critical advisories are never allowed: ${counts.critical}`)
}

function validateFinding(name, finding, policy, errors) {
  if (!isRecord(finding)) {
    errors.push(`${name} finding is malformed`)
    return
  }

  const expectedVia = policy.finding.via
  const expectedReferences = new Set(expectedVia.filter(source => typeof source === 'string'))
  const expectedAdvisories = expectedVia.filter(source => isRecord(source))
  const expectedUrls = new Set(expectedAdvisories.map(source => source.url))

  if (!Array.isArray(finding.via)) {
    errors.push(`${name} via fan-out is missing or malformed`)
  } else {
    if (expectedAdvisories.length > 0 && !finding.via.some(source => isRecord(source))) {
      errors.push(`${name} has no advisory details to validate`)
    }
    for (const source of finding.via) {
      if (typeof source === 'string') {
        if (!expectedReferences.has(source)) errors.push(`unapproved transitive reference for ${name}: ${source}`)
      } else if (!isRecord(source) || !expectedUrls.has(source.url)) {
        errors.push(`unapproved advisory for ${name}: ${isRecord(source) ? source.url ?? '<missing URL>' : '<malformed>'}`)
      } else if (!expectedAdvisories.some(expected => sameValue(source, expected))) {
        errors.push(`${name} advisory provenance does not match reviewed details`)
      }
    }
    if (!sameArrayMembers(finding.via, expectedVia)) errors.push(`${name} via fan-out differs from the reviewed closure`)
  }

  for (const field of ['name', 'severity', 'isDirect', 'effects', 'range', 'nodes', 'fixAvailable']) {
    const matches = field === 'effects' || field === 'nodes'
      ? sameArrayMembers(finding[field], policy.finding[field])
      : sameValue(finding[field], policy.finding[field])
    if (!matches) {
      errors.push(`${name} audit field ${field} differs from the reviewed finding`)
    }
  }
  if (name === 'braces' && finding.fixAvailable !== false) {
    errors.push('braces now reports a fix and must not use the no-patch exception')
  }

  const expectedKeys = Object.keys(policy.finding).sort()
  const actualKeys = Object.keys(finding).sort()
  if (!sameValue(actualKeys, expectedKeys)) errors.push(`${name} finding has missing or unexpected fields`)
}

export function evaluateWebsiteAuditReport(report, lock) {
  const errors = [...validateWebsiteLock(lock)]
  const counts = isRecord(report?.metadata?.vulnerabilities) ? report.metadata.vulnerabilities : {}
  const vulnerabilities = isRecord(report?.vulnerabilities) ? report.vulnerabilities : {}
  const packages = isRecord(lock?.packages) ? lock.packages : {}

  if (!isRecord(report)) errors.push('audit report is malformed')
  if (!isRecord(report?.metadata?.vulnerabilities)) errors.push('missing audit metadata vulnerability counts')
  if (!isRecord(report?.vulnerabilities)) errors.push('missing vulnerability map')
  if (!isRecord(lock?.packages)) errors.push('missing lockfile package map')
  if (report?.auditReportVersion !== 2) errors.push('missing or unsupported audit report version')

  validateCounts(counts, vulnerabilities, errors)

  const names = Object.keys(vulnerabilities)
  if (names.length > 0) {
    for (const name of Object.keys(POLICIES)) {
      if (!Object.hasOwn(vulnerabilities, name)) errors.push(`missing required vulnerability from reviewed closure: ${name}`)
    }
  }

  for (const [name, finding] of Object.entries(vulnerabilities)) {
    const policy = POLICIES[name]
    if (!policy) {
      errors.push(`unapproved vulnerable package: ${name}`)
      continue
    }
    validateFinding(name, finding, policy, errors)
  }

  return { errors, passed: errors.length === 0 }
}

function run() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'website')
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['audit', '--omit=dev', '--json', '--audit-level=high'], {
    cwd: projectRoot,
    encoding: 'utf8'
  })

  let report
  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    console.error('npm audit did not return valid JSON')
    if (result.stderr) console.error(result.stderr.trim())
    process.exit(1)
  }

  if (result.error || report.error) {
    console.error(`npm audit failed: ${report.error?.summary ?? result.error?.message ?? 'unknown error'}`)
    process.exit(1)
  }

  let lock
  try {
    lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
  } catch (error) {
    console.error(`website package lock could not be read: ${error.message}`)
    process.exit(1)
  }

  const evaluation = evaluateWebsiteAuditReport(report, lock)
  if (!evaluation.passed) {
    console.error('website npm audit policy failed')
    for (const error of evaluation.errors) console.error(`  ${error}`)
    process.exit(1)
  }

  const total = Number(report.metadata.vulnerabilities.total)
  if (total === 0) console.log('website npm audit policy passed with no known vulnerabilities')
  else console.log(`website npm audit policy passed with ${total} documented Docusaurus-internal braces findings (no patched braces release)`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run()
