const postcss = require('postcss')
const { resolveMatches } = require('./generateRules')
const { bigSign, escapeClassName } = require('./utils')

function buildApplyCache(applyCandidates, context) {
  for (let candidate of applyCandidates) {
    if (context.notClassCache.has(candidate) || context.applyClassCache.has(candidate)) {
      continue
    }

    if (context.classCache.has(candidate)) {
      context.applyClassCache.set(
        candidate,
        context.classCache.get(candidate).map(([meta, rule]) => [meta, rule.clone()])
      )
      continue
    }

    let matches = Array.from(resolveMatches(candidate, context))

    if (matches.length === 0) {
      context.notClassCache.add(candidate)
      continue
    }

    context.applyClassCache.set(candidate, matches)
  }

  return context.applyClassCache
}

// TODO: Apply `!important` stuff correctly instead of just skipping it
function extractApplyCandidates(params) {
  let candidates = params.split(/[\s\t\n]+/g)

  if (candidates[candidates.length - 1] === '!important') {
    return [candidates.slice(0, -1), true]
  }

  return [candidates, false]
}

function expandApplyAtRules(context) {
  return function processApply(root) {
    let applyCandidates = new Set()

    // Collect all @apply rules and candidates
    let applies = []
    root.walkAtRules('apply', (rule) => {
      let [candidates, important] = extractApplyCandidates(rule.params)

      for (let util of candidates) {
        applyCandidates.add(util)
      }
      applies.push(rule)
    })

    // Start the @apply process if we have rules with @apply in them
    if (applies.length > 0) {
      // Fill up some caches!
      let applyClassCache = buildApplyCache(applyCandidates, context)

      /**
       * When we have an apply like this:
       *
       * .abc {
       *    @apply hover:font-bold;
       * }
       *
       * What we essentially will do is resolve to this:
       *
       * .abc {
       *    @apply .hover\:font-bold:hover {
       *      font-weight: 500;
       *    }
       * }
       *
       * Notice that the to-be-applied class is `.hover\:font-bold:hover` and that the utility candidate was `hover:font-bold`.
       * What happens in this function is that we prepend a `.` and escape the candidate.
       * This will result in `.hover\:font-bold`
       * Which means that we can replace `.hover\:font-bold` with `.abc` in `.hover\:font-bold:hover` resulting in `.abc:hover`
       */
      // TODO: Should we use postcss-selector-parser for this instead?
      function replaceSelector(selector, utilitySelectors, candidate) {
        let needle = `.${escapeClassName(candidate)}`
        let utilitySelectorsList = utilitySelectors.split(/\s*,\s*/g)

        return selector
          .split(/\s*,\s*/g)
          .map((s) => {
            let replaced = []

            for (let utilitySelector of utilitySelectorsList) {
              let replacedSelector = utilitySelector.replace(needle, s)
              if (replacedSelector === utilitySelector) {
                continue
              }
              replaced.push(replacedSelector)
            }
            return replaced.join(', ')
          })
          .join(', ')
      }

      /** @type {Map<import('postcss').Node, [string, boolean, import('postcss').Node[]][]>} */
      let perParentApplies = new Map()

      // Collect all apply candidates and their rules
      for (let apply of applies) {
        let candidates = perParentApplies.get(apply.parent) || []

        perParentApplies.set(apply.parent, candidates)

        let [applyCandidates, important] = extractApplyCandidates(apply.params)

        for (let applyCandidate of applyCandidates) {
          if (!applyClassCache.has(applyCandidate)) {
            throw apply.error(
              `The \`${applyCandidate}\` class does not exist. If \`${applyCandidate}\` is a custom class, make sure it is defined within a \`@layer\` directive.`
            )
          }

          let rules = applyClassCache.get(applyCandidate)

          candidates.push([applyCandidate, important, rules])
        }
      }

      for (const [parent, candidates] of perParentApplies) {
        let siblings = []

        for (let [applyCandidate, important, rules] of candidates) {
          for (let [meta, node] of rules) {
            let root = postcss.root({ nodes: [node.clone()] })
            let canRewriteSelector =
              node.type !== 'atrule' || (node.type === 'atrule' && node.name !== 'keyframes')

            if (canRewriteSelector) {
              root.walkRules((rule) => {
                rule.selector = replaceSelector(parent.selector, rule.selector, applyCandidate)

                rule.walkDecls((d) => {
                  d.important = important
                })
              })
            }

            siblings.push([meta, root.nodes[0]])
          }
        }

        // Inject the rules, sorted, correctly
        const nodes = siblings.sort(([a], [z]) => bigSign(a.sort - z.sort)).map((s) => s[1])

        // `parent` refers to the node at `.abc` in: .abc { @apply mt-2 }
        parent.after(nodes)
      }

      for (let apply of applies) {
        // If there are left-over declarations, just remove the @apply
        if (apply.parent.nodes.length > 1) {
          apply.remove()
        } else {
          // The node is empty, drop the full node
          apply.parent.remove()
        }
      }

      // Do it again, in case we have other `@apply` rules
      processApply(root)
    }
  }
}

module.exports = expandApplyAtRules
