;;;; sam-openrig.asd --- a cell the organism made, its definitions one per file. Generated at each definition; edit freely, the component list is the load order.

(defsystem "sam-openrig"
  :description
  "OpenRig seat tools: rig whoami, queue, send as native tools"
  :class
  nodecode.kernel:layer
  :depends-on
  ("nodecode")
  :serial
  t
  :components
  ((:file "cell") (:file "openrig")))
