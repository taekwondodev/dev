export default {
  meta: { name: 'dev' },
  rules: {
    'no-source-comments': {
      meta: {
        type: 'suggestion',
        schema: [],
        messages: {
          clarify:
            'Express intent in code; preserve architectural rationale in an ADR before removing this comment.',
        },
      },
      createOnce(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === 'Shebang') continue
              context.report({ loc: comment.loc, messageId: 'clarify' })
            }
          },
        }
      },
    },
  },
}
