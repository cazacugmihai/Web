// Od.ts
// (C) Ralph Becket, 2016
//
// Observables-based vDOM.
//
// Virtual-DOM schemes are all the rage.  Essentially, manually updating the
// HTML DOM is hard to do efficiently and correctly.  vDOM schemes instead
// (typically) take the approach of
// - whenever something "interesting" happens (the user clicks something, an
//   AJAX request returns, that sort of thing) then an application-provided
//   function is called which
// - constructs a new vDOM structure (a cheaper, abstract) representing
//   what the DOM should look like and
// - the vDOM library then works out the minimal set of DOM updates required
//   to bring the DOM proper into line with the new vDOM representation.
//
// This has turned out to be simpler and more efficient, at scale, than other
// approaches.
//
// There are typically two flies in the ointment of the schemes I have studied:
// (1) the application re-generates the entire vDOM at each event, which is
//     then compared against the entire DOM; and
// (2) people want to include "components" in their vDOM, namely reusable
//     abstractions (e.g., for auto-complete inputs, grids, etc.).  These
//     things have always felt a little clunky to me in execution.
//
// My approach kills both these birds with one stone: observables.  The idea
// behind observables is that one can attach functions to them (subscriptions)
// to be executed whenever the value of the observable changes.
//
// Every "dynamic" DOM subtree (i.e., something that can change as the
// application runs) is managed via an observable whose value is a vDOM
// subtree.  When the observable changes, the patching algorithm is only
// applied to the affected DOM subtree.  In Od terms, such a structure is
// a 'component'.  A DOM subtree managed by a component is handled entirely
// and only by that component: parent components and subcomponents 
// operate entirely independently.
//
// This mechanism is general: "components" are just observables, like any
// other managed part of the DOM/vDOM relationship.
//
// Any DOM nodes that are removed are queued for "stripping" where any
// dangling event handlers are removed (this is important to avoid garbage
// retention).  Stripping happens in the background so it doesn't interfere
// with rendering.
//
// Unless explicitly told otherwise, Od normally batches DOM updates to be
// applied via requestAnimationFrame or some equivalent fallback mechanism.
//
//
//
// Credit where it's due: the following efforts have been inspirational and,
// in many cases, of enormous practical benefit: Knockout, Mithril, Inferno,
// and React.  I'd also like to mention the reactive school, but in the end
// I find the observables-based approach more natural.  For today, at least.
//
/// <reference path="./Obs.ts"/>
var Od;
(function (Od) {
    var debug = false;
    ;
    Od.text = function (text) {
        return ({ isIVdom: true, text: isNully(text) ? "" : text.toString() });
    };
    // Construct a vDOM node.
    Od.element = function (tag, props, childOrChildren) {
        tag = tag.toUpperCase();
        var children = (!childOrChildren
            ? null
            : isArray(childOrChildren)
                ? childOrChildren
                : [childOrChildren]);
        return { isIVdom: true, tag: tag, props: props, children: children };
    };
    Od.component = function (name, fn) {
        var existingVdom = existingNamedComponentInstance(name);
        if (existingVdom)
            return existingVdom;
        var component = {
            isIVdom: true,
            obs: null,
            subcomponents: null,
            dom: null
        };
        component.obs = Obs.fn(function () { return updateComponent(component, fn); });
        // Attach this component as a subcomponent of the parent context.
        addAsSubcomponentOfParent(name, component);
        return component;
    };
    // The current parent component scope, if any.
    var parentComponent = null;
    var existingNamedComponentInstance = function (name) {
        return (name != null) &&
            parentComponent &&
            parentComponent.subcomponents &&
            parentComponent.subcomponents[name];
    };
    var anonymousSubcomponentsKey = "__OdAnonymousSubcomponents__";
    var addAsSubcomponentOfParent = function (name, child) {
        if (!parentComponent)
            return;
        if (!parentComponent.subcomponents)
            parentComponent.subcomponents = {};
        var subcomponents = parentComponent.subcomponents;
        if (name != null) {
            // This is a named sub-component which will persist for the
            // lifetime of the parent component.
            subcomponents[name] = child;
        }
        else {
            // This child has no name.  Aww.  In this case we store a list
            // of these nameless children under a special name.
            var anonSubcomponents = subcomponents[anonymousSubcomponentsKey];
            if (!anonSubcomponents) {
                subcomponents[anonymousSubcomponentsKey] = [child];
            }
            else {
                anonSubcomponents.push(child);
            }
        }
    };
    // Construct a static DOM subtree from an HTML string.
    // Note: this vDOM node can, like DOM nodes, only appear
    // in one place in the resulting DOM!  If you need copies,
    // you need duplicate fromHtml instances.
    Od.fromHtml = function (html) {
        // First, turn the HTML into a DOM tree.
        var tmp = document.createElement("DIV");
        tmp.innerHTML = html;
        // If this is a bunch of nodes, return the whole DIV.
        var dom = (tmp.childNodes.length === 1 ? tmp.firstChild : tmp);
        // We create a pretend component to host the HTML.
        var vdom = {
            isIVdom: true,
            obs: staticHtmlObs,
            subscription: staticHtmlSubs,
            dom: dom
        };
        return vdom;
    };
    // Take a DOM subtree directly.
    // Note: this vDOM node can, like DOM nodes, only appear
    // in one place in the resulting DOM!  If you need copies,
    // you need duplicate fromDom instances.
    Od.fromDom = function (dom) {
        // We create a pretend component to host the HTML.
        var vdom = {
            isIVdom: true,
            obs: staticHtmlObs,
            subscription: staticHtmlSubs,
            dom: dom
        };
        return vdom;
    };
    // Bind a vDOM node to a DOM node.  For example,
    // Od.bind(myVdom, document.body.getElementById("foo"));
    // This will either update or replace the DOM node in question.
    Od.bind = function (vdom, dom) {
        var domParent = dom.parentNode;
        var node = Od.patchDom(vdom, dom, domParent);
        return node;
    };
    // Bind a vDOM node to a DOM node as new child.  For example,
    // Od.appendChild(myVdom, document.body);
    Od.appendChild = function (vdom, domParent) {
        var dom = null;
        var node = Od.patchDom(vdom, dom, domParent);
        return node;
    };
    // Dispose of a component, removing any observable dependencies
    // it may have.
    Od.dispose = function (component) {
        if (!component)
            return;
        if (component.obs) {
            Obs.dispose(component.obs);
            component.obs = null;
        }
        if (component.dom) {
            lifecycleHooks("removed", component.dom);
            enqueueNodeForStripping(component.dom);
            component.dom = null;
        }
        if (component.subcomponents) {
            disposeSubcomponents(component.subcomponents);
            component.subcomponents = null;
        }
    };
    var disposeSubcomponents = function (subcomponents) {
        for (var name in subcomponents) {
            var subcomponent = subcomponents[name];
            if (name === anonymousSubcomponentsKey) {
                // These are anonymous subcomponents, kept in an list.
                subcomponent.forEach(Od.dispose);
            }
            else {
                Od.dispose(subcomponent);
            }
        }
    };
    // Normally, component updates will be batched via requestAnimationFrame
    // (i.e., they will occur at most once per display frame).  Setting this
    // to false ensures updates happen eagerly (i.e., they will not be
    // deferred).
    Od.deferComponentUpdates = true;
    // ---- Implementation detail. ----
    var isArray = function (x) { return x instanceof Array; };
    var isNully = function (x) { return x == null; };
    Od.patchDom = function (vdomOrString, dom, domParent) {
        var vdom = (typeof (vdomOrString) === "string"
            ? Od.text(vdomOrString)
            : vdomOrString);
        if (vdom.tag)
            return patchElement(vdom, dom, domParent);
        if (vdom.obs)
            return patchComponent(vdom, dom, domParent);
        return patchText(vdom, dom, domParent);
    };
    var patchText = function (vdom, dom, domParent) {
        var newText = vdom.text;
        var newDom = (!dom || dom.nodeName !== "#text"
            ? document.createTextNode(newText)
            : dom);
        if (newDom.nodeValue !== newText)
            newDom.nodeValue = newText;
        replaceNode(newDom, dom, domParent);
        return newDom;
    };
    var patchComponent = function (component, dom, domParent) {
        // The rule is: the DOM node in the component is always up-to-date
        // with respect to the underlying observable.
        //
        // When patching, therefore, there are the following possibilities:
        //
        // (1) The component's DOM node is the same as the node to be patched
        // and nothing needs to be done.
        //
        // (2) The node to be patched is null, in which case we append the
        // component's DOM node to the patch parent node.
        //
        // (3) The node to be patched is different, in which case we replace
        // it with the component's DOM node.
        var newDom = component.dom;
        if (newDom !== dom)
            replaceNode(newDom, dom, domParent);
        return newDom;
    };
    var patchElement = function (vdom, dom, domParent) {
        var tag = vdom.tag;
        var vdomProps = vdom.props;
        var vdomChildren = vdom.children;
        var elt = dom;
        var newElt = (!elt || elt.tagName !== tag || domBelongsToComponent(elt)
            ? document.createElement(tag)
            : elt);
        if (newElt !== elt)
            trace("  Created", tag);
        patchProps(newElt, vdomProps);
        patchChildren(newElt, vdomChildren);
        replaceNode(newElt, dom, domParent);
        return newElt;
    };
    var patchProps = function (elt, newProps) {
        var oldProps = getEltOdProps(elt);
        if (newProps)
            for (var prop in newProps)
                if (prop !== "style")
                    setDomProp(elt, prop, newProps[prop]);
        if (oldProps)
            for (var prop in oldProps)
                if (!(prop in newProps))
                    removeDomProp(elt, prop);
        // Style properties are special.
        var eltStyleProps = oldProps && oldProps["style"];
        var vdomStyleProps = newProps && newProps["style"];
        patchStyleProps(elt, eltStyleProps, vdomStyleProps);
        setEltOdProps(elt, newProps);
    };
    var patchStyleProps = function (elt, oldStyleProps, newStyleProps) {
        if (typeof (newStyleProps) === "string") {
            elt.style = newStyleProps;
            return;
        }
        if (!newStyleProps) {
            // Don't reset all style properties unless there were some before.
            if (oldStyleProps)
                elt.style = null;
            return;
        }
        var eltStyle = elt.style;
        for (var prop in newStyleProps)
            eltStyle[prop] = newStyleProps[prop];
        if (!oldStyleProps)
            return;
        for (var prop in oldStyleProps)
            if (!(prop in newStyleProps))
                eltStyle[prop] = null;
    };
    var removeDomProp = function (dom, prop) {
        dom[prop] = null;
        if (dom instanceof HTMLElement)
            dom.removeAttribute(prop);
    };
    var setDomProp = function (dom, prop, value) {
        if (prop.substr(0, 5) === "data-") {
            dom.setAttribute(prop, value);
            return;
        }
        if (prop === "class")
            prop = "className"; // This is convenient.
        dom[prop] = value;
    };
    var patchChildren = function (elt, vdomChildren) {
        if (!vdomChildren)
            vdomChildren = [];
        if (elt.keyed)
            reorderKeyedChildren(vdomChildren, elt);
        var eltChild = elt.firstChild;
        var numVdomChildren = vdomChildren.length;
        // Patch or add the number of required children.
        for (var i = 0; i < numVdomChildren; i++) {
            trace("Patching child", i + 1);
            var vdomChild = vdomChildren[i];
            var nextChild = Od.patchDom(vdomChild, eltChild, elt).nextSibling;
            eltChild = nextChild;
            trace("Patched child", i + 1);
        }
        // Remove any extraneous children.
        while (eltChild) {
            var nextSibling = eltChild.nextSibling;
            replaceNode(null, eltChild, elt);
            eltChild = nextSibling;
            trace("Removed child", ++i);
        }
    };
    // A common vDOM optimisation for supporting lists is to associate
    // each list item with a key property.  Keyed child nodes are reordered
    // to suit the vDOM before patching.  This can dramatically reduce
    // DOM node creation when, say, the list order changes or an item
    // is removed.  In Od we further insist that the parent element have
    // the property 'keyed: true'.
    var reorderKeyedChildren = function (vdomChildren, dom) {
        trace("  Reordering keyed children.");
        var vChildren = vdomChildren; // This is safe.
        var domFirstChild = dom.firstChild;
        var numVChildren = vChildren.length;
        if (numVChildren === 0 || !domFirstChild)
            return;
        // Construct a mapping from keys to DOM nodes.
        var keyToDom = {};
        for (var domI = dom.firstChild; domI; domI = domI.nextSibling) {
            var keyI = domI.key;
            if (isNully(keyI))
                return; // We insist that all children have keys.
            keyToDom[keyI] = domI;
        }
        // Reorder the DOM nodes to match the vDOM order, unless
        // we need to insert a new node.
        var domI = dom.firstChild;
        for (var i = 0; i < numVChildren; i++) {
            var vdomI = vChildren[i];
            var vTagI = vdomI.tag;
            if (isNully(vTagI) && vdomI.dom)
                vTagI = vdomI.dom.nodeName;
            if (!vTagI)
                return; // This only works for ordinary elements.
            var vKeyI = vdomPropsKey(vdomI.props);
            if (isNully(vKeyI))
                return;
            var dKeyI = domI && domI.key;
            var domVKeyI = keyToDom[vKeyI];
            if (domI) {
                if (dKeyI === vKeyI) {
                    domI = domI.nextSibling;
                }
                else if (domVKeyI) {
                    dom.insertBefore(domVKeyI, domI);
                }
                else {
                    dom.insertBefore(document.createElement(vTagI), domI);
                }
            }
            else if (domVKeyI) {
                dom.appendChild(domVKeyI);
            }
            else {
                dom.appendChild(document.createElement(vTagI));
            }
        }
    };
    // This is used for the static HTML constructors to pretend they're
    // derived from observables.
    var staticHtmlObs = Obs.of(null);
    var staticHtmlSubs = null;
    var propsToPropAssocList = function (props) {
        if (!props)
            return null;
        var propAssocList = [];
        var keys = Object.keys(props).sort();
        var iTop = keys.length;
        for (var i = 0; i < iTop; i++) {
            var key = keys[i];
            propAssocList.push(key, props[key]);
        }
        return propAssocList;
    };
    var emptyPropList = [];
    // We attach lists of (ordered) property names to elements so we can
    // perform property updates in O(n) time.
    var getEltOdProps = function (elt) {
        return elt.__Od__props;
    };
    var setEltOdProps = function (elt, props) {
        elt.__Od__props = props;
    };
    var vdomPropsKey = function (props) {
        return props && props["key"];
    };
    var getDomComponent = function (dom) {
        return dom.__Od__component;
    };
    var setDomComponent = function (dom, component) {
        if (dom)
            dom.__Od__component = component;
    };
    var domBelongsToComponent = function (dom) {
        return !!getDomComponent(dom);
    };
    var updateComponent = function (component, fn) {
        // If the component has anonymous subcomponents, we should dispose
        // of them now -- they will be recreated by fn if needed.  Named
        // subcomponents will persist.
        disposeAnonymousSubcomponents(component);
        // Evaluate the vDOM function with this component as the parent for
        // any sub-components it generates.
        var tmp = parentComponent;
        parentComponent = component;
        var vdom = fn();
        parentComponent = tmp;
        // If a DOM node is already associated with the component, we
        // can defer the patching operation (which is nicer for the
        // web browser).
        if (!component.dom) {
            var dom = Od.patchDom(vdom, null, null);
            setDomComponent(dom, component);
            component.dom = dom;
            lifecycleHooks("created", dom);
        }
        else {
            // The updated lifecycle hooks will be invoked here.
            enqueueComponentForPatching(component, vdom);
        }
        return vdom;
    };
    var disposeAnonymousSubcomponents = function (component) {
        var anonymousSubcomponents = component.subcomponents &&
            component.subcomponents[anonymousSubcomponentsKey];
        if (!anonymousSubcomponents)
            return;
        anonymousSubcomponents.forEach(Od.dispose);
        component.subcomponents[anonymousSubcomponentsKey] = null;
    };
    // We defer DOM updates using requestAnimationFrame.  It's better to
    // batch DOM updates where possible.
    var requestAnimationFrameSubstitute = function (callback) {
        return setTimeout(callback, 16); // 16 ms = 1/60 s.
    };
    var requestAnimationFrame = window.requestAnimationFrame || requestAnimationFrameSubstitute;
    var componentsAwaitingUpdate = [];
    var requestAnimationFrameID = 0;
    var enqueueComponentForPatching = function (component, vdom) {
        if (!Od.deferComponentUpdates) {
            patchUpdatedComponent(component, vdom);
            return;
        }
        componentsAwaitingUpdate.push(component);
        if (requestAnimationFrameID)
            return;
        requestAnimationFrameID = requestAnimationFrame(patchQueuedComponents);
    };
    var patchQueuedComponents = function () {
        // Ensure we don't patch the same component twice, should it have
        // been updated more than once.
        var patchedComponents = {};
        var iTop = componentsAwaitingUpdate.length;
        for (var i = 0; i < iTop; i++) {
            var component_1 = componentsAwaitingUpdate[i];
            var id = component_1.obs.obsid;
            if (patchedComponents[id])
                continue;
            trace("Patching queued component #", id);
            patchUpdatedComponent(component_1);
            patchedComponents[id] = true;
        }
        // Clear the queue.
        componentsAwaitingUpdate = [];
        // Tell enqueueComponentForPatching that it needs to make a
        // new RAF request on the next update.
        requestAnimationFrameID = 0;
        // XXX Try for now to ensure any pending Od events are processed here.
        processPendingOdEvents();
    };
    var patchUpdatedComponent = function (component, vdom) {
        vdom = (vdom != null ? vdom : component.obs());
        var dom = component.dom;
        var domParent = dom && dom.parentNode;
        if (domWillBeReplaced(vdom, dom)) {
            // Component DOM nodes don't get stripped by default.
            setDomComponent(dom, null);
            enqueueNodeForStripping(dom);
        }
        else {
            // Component DOM nodes don't get patched by default.
            setDomComponent(dom, null);
        }
        var newDom = Od.patchDom(vdom, dom, domParent);
        setDomComponent(newDom, component);
        lifecycleHooks("updated", newDom);
        component.dom = newDom;
    };
    // A DOM node will be replaced by a new DOM structure if it
    // cannot be adjusted to match the corresponding vDOM node.
    var domWillBeReplaced = function (vdom, dom) {
        if (!dom)
            return false;
        if (typeof (vdom) === "string")
            return dom.nodeType !== Node.TEXT_NODE;
        return dom.nodeName !== vdom.tag;
    };
    // We track DOM nodes we've discarded so we can clean them up, remove
    // dangling event handlers and that sort of thing.  We do this in
    // the background to reduce the time between patching the DOM and
    // handing control back to the browser so it can re-paint.
    var nodesPendingStripping = [];
    var enqueueNodeForStripping = function (dom) {
        if (!dom)
            return;
        if (domBelongsToComponent(dom))
            return; // Can't touch this!
        trace("  Discarded", dom.nodeName || "#text");
        nodesPendingStripping.push(dom);
        if (stripNodesID)
            return;
        stripNodesID = setTimeout(stripNodes, 100);
    };
    var stripNodesID = 0;
    var stripNodes = function () {
        var dom = nodesPendingStripping.pop();
        while (dom) {
            stripNode(dom);
            var dom = nodesPendingStripping.pop();
        }
    };
    var stripNode = function (dom) {
        // We don't want to strip anything owned by a sub-component.
        if (domBelongsToComponent(dom))
            return; // Can't touch this!
        // Strip any properties...
        var props = getEltOdProps(dom);
        for (var prop in props)
            dom[prop] = null;
        // Recursively strip any child nodes.
        var children = dom.childNodes;
        var numChildren = children.length;
        for (var i = 0; i < numChildren; i++)
            stripNode(children[i]);
    };
    // Decide how a DOM node should be replaced.
    var replaceNode = function (newDom, oldDom, domParent) {
        if (!newDom) {
            if (!oldDom)
                return;
            enqueueNodeForStripping(oldDom);
            if (domParent)
                domParent.removeChild(oldDom);
        }
        else {
            if (!oldDom) {
                trace("  Inserted", newDom.nodeName || "#text");
                if (domParent)
                    domParent.appendChild(newDom);
            }
            else {
                if (newDom === oldDom)
                    return;
                enqueueNodeForStripping(oldDom);
                if (!domParent)
                    return;
                trace("  Inserted", newDom.nodeName || "#text");
                if (domParent)
                    domParent.replaceChild(newDom, oldDom);
            }
        }
    };
    // Some component nodes will have life-cycle hooks to call.
    var lifecycleHooks = function (what, dom) {
        var props = dom && getEltOdProps(dom);
        var hook = props && props["onodevent"];
        if (!hook)
            return;
        pendingLifecycleCallbacks.push(function () { return hook(what, dom); });
        if (pendingOdEventsID)
            return;
        pendingOdEventsID = setTimeout(processPendingOdEvents, 20); // XXX!
    };
    var pendingOdEventsID = 0;
    var pendingLifecycleCallbacks = [];
    // We process Od lifecycle events after the DOM has had a chance to
    // rearrange itself.
    var processPendingOdEvents = function () {
        for (var i = 0; i < pendingLifecycleCallbacks.length; i++)
            pendingLifecycleCallbacks[i]();
        pendingLifecycleCallbacks = [];
        pendingOdEventsID = 0;
    };
    // Debugging.
    var trace = function () {
        if (!debug)
            return;
        if (!window.console || !window.console.log)
            return;
        console.log.apply(console, arguments);
    };
})(Od || (Od = {}));
