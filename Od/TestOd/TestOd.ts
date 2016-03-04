﻿window.onload = () => {

    const e = Od.element;
    const t = Od.text;
    const d = (v: Od.Vdom): Node => Od.patchDom(v, null, null);

    const nav = (dom: Node, path: number[]): Node => {
        var iTop = path.length;
        for (var i = 0; i < iTop; i++) {
            dom = dom.childNodes[path[i]];
            if (!dom) throw new Error("Node does not match path " +
                JSON.stringify(path)
            );
        }
        return dom;
    };

    const chk =
    (   dom: Node,
        path: number[],
        tag: string,
        numChildren?: number,
        props?: Object
    ): boolean => {
        var dom = nav(dom, path);
        var textMatches =
            (dom.nodeType === Node.TEXT_NODE) &&
            (tag[0] === "#") &&
            (dom.textContent === tag.substr(1));
        var tagMatches =
            ((dom as HTMLElement).tagName === tag);
        if (!textMatches && !tagMatches)
            throw new Error("Node tag is not " + tag);
        if (numChildren != undefined && dom.childNodes.length != numChildren)
            throw new Error("Node does not have " + numChildren + " children.");
        return chkProps(dom, props);
    };

    const chkProps = (dom: Node, props: Object): boolean => {
        if (!props) return true;
        for (var key in props) {
            const value = props[key];
            if ((value && dom[key] !== value))
                throw new Error("Node does not have expected value for " +
                    key);
            if ((!value && dom[key]))
                throw new Error("Node has unexpected value for " +
                    key);
        }
        return true;
    };

    const same = (x: Node, y: Node): boolean => {
        if (x === y) return true;
        throw ("Nodes should be identical.");
    };

    const diff = (x: Node, y: Node): boolean => {
        if (x !== y) return true;
        throw ("Nodes should be different.");
    };

    Test.run("Patch xyz vs null", () => {
        var A = "xyz";
        var B = null as Node;
        var C = Od.patchDom(A, B, null);
        chk(C, [], "#xyz");
    });

    Test.run("Patch xyz vs pqr", () => {
        var A = "xyz";
        var B = d("pqr");
        var C = Od.patchDom(A, B, null);
        chk(C, [], "#xyz");
        same(B, C);
    });

    Test.run("Patch xyz vs xyz", () => {
        var A = "xyz";
        var B = d("xyz");
        var C = Od.patchDom(A, B, null);
        chk(C, [], "#xyz");
        same(B, C);
    });

    Test.run("Patch xyz vs DIV", () => {
        var A = "xyz";
        var B = d(e("DIV"));
        var C = Od.patchDom(A, B, null);
        chk(C, [], "#xyz");
        diff(B, C);
    });

    Test.run("Patch DIV(xyz) vs null", () => {
        var A = e("DIV", null, "xyz");
        var B = null;
        var C = Od.patchDom(A, B, null);
        chk(C, [], "DIV", 1);
        chk(C, [0], "#xyz");
    });

    Test.run("Patch DIV(xyz) vs pqr", () => {
        var A = e("DIV", null, "xyz");
        var B = d("pqr");
        var C = Od.patchDom(A, B, null);
        chk(C, [], "DIV", 1);
        chk(C, [0], "#xyz");
        diff(B, C);
    });

    Test.run("Patch DIV(xyz) vs DIV(pqr)", () => {
        var A = e("DIV", null, "xyz");
        var B = d(e("DIV", null, "pqr"));
        var C = Od.patchDom(A, B, null);
        chk(C, [], "DIV", 1);
        chk(C, [0], "#xyz");
        same(B, C);
    });

    Test.run("Patch DIV(xyz) vs P", () => {
        var A = e("DIV", null, "xyz");
        var B = d(e("P"));
        var C = Od.patchDom(A, B, null);
        chk(C, [], "DIV", 1);
        chk(C, [0], "#xyz");
        diff(B, C);
    });

    Test.run("Patch DIV vs DIV(xyz, pqr)", () => {
        var A = e("DIV");
        var B = d(e("DIV", null, ["xyz", "pqr"]));
        var C = Od.patchDom(A, B, null);
        chk(C, [], "DIV", 0);
        same(B, C);
    });

};