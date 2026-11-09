;;;; cell.lisp --- openrig: the package this cell's definitions read in.
;;;;
;;;; Written by new-cell. The cell's code is openrig.lisp beside it, in
;;;; (in-package #:sam-openrig); a (define-cell openrig ...) there declares its
;;;; commands, tools and settings: (help :cells).

(defpackage #:sam-openrig
  (:use #:cl #:nodecode.kernel #:nodecode.evolved))

(in-package #:sam-openrig)

(define-peripheral openrig :not-running t)
