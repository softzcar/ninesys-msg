document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('login-form');
    const errorMessage = document.getElementById('error-message');

    // If user is already logged in, redirect to dashboard
    if (localStorage.getItem('jwt_token')) {
        window.location.href = '/dashboard.html';
    }

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorMessage.textContent = ''; // Clear previous errors

        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        try {
            const response = await fetch('/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password }),
            });

            const data = await response.json();

            if (response.ok) {
                // Store the token in localStorage
                localStorage.setItem('jwt_token', data.token);
                // Redirect to the dashboard
                window.location.href = '/dashboard.html';
            } else {
                errorMessage.textContent = data.message || 'Error en el login.';
            }
        } catch (error) {
            console.error('Error en el login:', error);
            errorMessage.textContent = 'No se pudo conectar con el servidor.';
        }
    });
});
