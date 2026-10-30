(function () {
    try {
        var mode = localStorage.getItem('mv-theme') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', mode);
    } catch (_) {}
})();