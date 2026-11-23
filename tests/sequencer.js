'use strict';

/** Runs the QA files in numeric order (01 ... 07) instead of Jest's default. */
const Sequencer = require('@jest/test-sequencer').default;

class NumericSequencer extends Sequencer {
  sort(tests) {
    return [...tests].sort((a, b) => a.path.localeCompare(b.path));
  }
}

module.exports = NumericSequencer;
